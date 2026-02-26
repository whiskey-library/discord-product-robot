import fetch from "node-fetch";

const GITHUB_REPO = "pawaninsta/discord-product-robot";
const WORKFLOW_FILE = "claude-dev.yml";

// --- Shared helpers ---

async function dispatchWorkflow(pat, inputs) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );
  return res;
}

async function getIssueThreadId(pat, issueNumber) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/issues/${issueNumber}`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (res.status === 404) {
      return { threadId: null, issue: null, error: "not_found" };
    }
    if (!res.ok) {
      return { threadId: null, issue: null, error: `http_${res.status}` };
    }
    const issue = await res.json();
    const match = issue.body?.match(/<!-- discord_thread_id: (\d{17,20}) -->/);
    const threadId = match ? match[1] : null;
    return { threadId, issue, error: null };
  } catch (err) {
    return { threadId: null, issue: null, error: err.message || String(err) };
  }
}

async function postToThread(client, threadId, content) {
  if (!threadId) return;
  try {
    const thread = await client.channels.fetch(threadId);
    if (!thread?.send) return;
    const text = String(content ?? "").trim();
    if (!text) return;
    const MAX = 1900;
    for (let i = 0; i < text.length; i += MAX) {
      await thread.send({ content: text.slice(i, i + MAX) });
    }
  } catch (err) {
    console.warn("DEV-CMD: failed to post to thread:", err?.message || String(err));
  }
}

// --- /dev command handler ---

export async function handleDevCommand(interaction) {
  const task = interaction.options.getString("task");
  const taskType = interaction.options.getString("type") || "feature";

  if (task.length < 10) {
    await interaction.reply({
      content: "Task description must be at least 10 characters long.",
      ephemeral: true,
    });
    return;
  }
  if (task.length > 500) {
    await interaction.reply({
      content: "Task description must be 500 characters or fewer.",
      ephemeral: true,
    });
    return;
  }

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    await interaction.reply({
      content: "`GITHUB_PAT` is not configured. Cannot trigger the dev agent workflow.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: "Starting dev agent... creating a log thread...",
    ephemeral: true,
  });

  // Create a thread for logging
  let logThread = null;
  try {
    const channel = interaction.channel;
    if (channel?.threads?.create) {
      const stamp = new Date()
        .toISOString()
        .replace("T", " ")
        .slice(0, 16);
      const threadName = `dev plan | ${taskType} | ${interaction.user.username} | ${stamp}`;
      logThread = await channel.threads.create({
        name: threadName.slice(0, 100),
        autoArchiveDuration: 60,
        reason: `/dev command by ${interaction.user.tag}`,
      });
    }
  } catch (e) {
    console.warn("DEV-CMD: failed to create log thread:", e?.message || String(e));
  }

  const threadId = logThread?.id || "";

  try {
    const res = await dispatchWorkflow(pat, {
      phase: "plan",
      task,
      task_type: taskType,
      discord_user: interaction.user.username,
      thread_id: threadId,
      issue_number: "",
      feedback: "",
    });

    if (res.status === 204) {
      const actionsUrl = `https://github.com/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}`;
      const lines = [
        `**Dev agent planning started!**`,
        `**Requested by:** ${interaction.user.username}`,
        `**Type:** ${taskType}`,
        `**Task:** ${task}`,
        ``,
        `Claude is creating a plan. It will be posted here with a GitHub Issue link.`,
        `You can then use \`/dev-revise\` to request changes or \`/dev-approve\` to implement.`,
        `[View workflow runs](${actionsUrl})`,
      ];

      if (logThread) {
        await logThread.send({ content: lines.join("\n") });
        await interaction.editReply({
          content: `Dev agent dispatched! Follow progress in ${logThread}.`,
        });
      } else {
        await interaction.editReply({ content: lines.join("\n") });
      }
    } else {
      const body = await res.text();
      console.error("DEV-CMD: GitHub API error:", res.status, body);
      const msg = `Failed to trigger workflow (HTTP ${res.status}). Check GITHUB_PAT permissions.`;
      if (logThread) await logThread.send({ content: msg });
      await interaction.editReply({ content: msg });
    }
  } catch (err) {
    console.error("DEV-CMD: dispatch error:", err);
    const msg = `Error triggering dev agent: ${err.message || String(err)}`;
    if (logThread) await logThread.send({ content: msg });
    await interaction.editReply({ content: msg });
  }
}

// --- /dev-revise command handler ---

export async function handleDevReviseCommand(interaction) {
  const issueNumber = interaction.options.getInteger("issue");
  const feedback = interaction.options.getString("feedback");

  if (feedback.length < 10) {
    await interaction.reply({
      content: "Feedback must be at least 10 characters long.",
      ephemeral: true,
    });
    return;
  }
  if (feedback.length > 500) {
    await interaction.reply({
      content: "Feedback must be 500 characters or fewer.",
      ephemeral: true,
    });
    return;
  }

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    await interaction.reply({
      content: "`GITHUB_PAT` is not configured. Cannot trigger the dev agent workflow.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const { threadId, issue, error } = await getIssueThreadId(pat, issueNumber);

  if (error === "not_found") {
    await interaction.editReply({
      content: `Issue #${issueNumber} not found. Check the number and try again.`,
    });
    return;
  }
  if (error) {
    await interaction.editReply({
      content: `Could not reach GitHub API: ${error}`,
    });
    return;
  }
  if (issue.state === "closed") {
    await interaction.editReply({
      content: `Issue #${issueNumber} is already closed. It may have already been implemented.`,
    });
    return;
  }

  if (!threadId) {
    await interaction.editReply({
      content: `Warning: Could not find a Discord thread ID in issue #${issueNumber}. The workflow will run but results won't be posted to a thread.`,
    });
  }

  // Post status to thread
  await postToThread(
    interaction.client,
    threadId,
    `**Revising plan for issue #${issueNumber}...**\n**Feedback:** ${feedback}\n**Requested by:** ${interaction.user.username}`
  );

  try {
    const res = await dispatchWorkflow(pat, {
      phase: "revise",
      task: "",
      task_type: "",
      discord_user: interaction.user.username,
      thread_id: threadId || "",
      issue_number: String(issueNumber),
      feedback,
    });

    if (res.status === 204) {
      await interaction.editReply({
        content: `Revision dispatched for issue #${issueNumber}. Claude is revising the plan.`,
      });
    } else {
      const body = await res.text();
      console.error("DEV-CMD: GitHub API error:", res.status, body);
      await interaction.editReply({
        content: `Failed to trigger workflow (HTTP ${res.status}). Check GITHUB_PAT permissions.`,
      });
    }
  } catch (err) {
    console.error("DEV-CMD: dispatch error:", err);
    await interaction.editReply({
      content: `Error triggering dev agent: ${err.message || String(err)}`,
    });
  }
}

// --- /dev-approve command handler ---

export async function handleDevApproveCommand(interaction) {
  const issueNumber = interaction.options.getInteger("issue");

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    await interaction.reply({
      content: "`GITHUB_PAT` is not configured. Cannot trigger the dev agent workflow.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const { threadId, issue, error } = await getIssueThreadId(pat, issueNumber);

  if (error === "not_found") {
    await interaction.editReply({
      content: `Issue #${issueNumber} not found. Check the number and try again.`,
    });
    return;
  }
  if (error) {
    await interaction.editReply({
      content: `Could not reach GitHub API: ${error}`,
    });
    return;
  }
  if (issue.state === "closed") {
    await interaction.editReply({
      content: `Issue #${issueNumber} is already closed. It may have already been implemented.`,
    });
    return;
  }

  if (!threadId) {
    await interaction.editReply({
      content: `Warning: Could not find a Discord thread ID in issue #${issueNumber}. The workflow will run but results won't be posted to a thread.`,
    });
  }

  // Post status to thread
  await postToThread(
    interaction.client,
    threadId,
    `**Implementing plan from issue #${issueNumber}...**\nApproved by ${interaction.user.username}. Claude is now writing code.`
  );

  try {
    const res = await dispatchWorkflow(pat, {
      phase: "implement",
      task: "",
      task_type: "",
      discord_user: interaction.user.username,
      thread_id: threadId || "",
      issue_number: String(issueNumber),
      feedback: "",
    });

    if (res.status === 204) {
      await interaction.editReply({
        content: `Implementation dispatched for issue #${issueNumber}. Claude is writing code. A PR will be posted when done.`,
      });
    } else {
      const body = await res.text();
      console.error("DEV-CMD: GitHub API error:", res.status, body);
      await interaction.editReply({
        content: `Failed to trigger workflow (HTTP ${res.status}). Check GITHUB_PAT permissions.`,
      });
    }
  } catch (err) {
    console.error("DEV-CMD: dispatch error:", err);
    await interaction.editReply({
      content: `Error triggering dev agent: ${err.message || String(err)}`,
    });
  }
}

import fetch from "node-fetch";

const GITHUB_REPO = "pawaninsta/discord-product-robot";
const WORKFLOW_FILE = "claude-dev.yml";

export async function handleDevCommand(interaction) {
  const task = interaction.options.getString("task");
  const taskType = interaction.options.getString("type") || "feature";

  // Validate task length
  if (task.length < 10) {
    await interaction.reply({
      content: "❌ Task description must be at least 10 characters long.",
      ephemeral: true,
    });
    return;
  }
  if (task.length > 500) {
    await interaction.reply({
      content: "❌ Task description must be 500 characters or fewer.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: "🧠 Starting dev agent… creating a log thread…",
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
      const threadName = `dev • ${taskType} • ${interaction.user.username} • ${stamp}`;
      logThread = await channel.threads.create({
        name: threadName.slice(0, 100),
        autoArchiveDuration: 60,
        reason: `/dev command by ${interaction.user.tag}`,
      });
    }
  } catch (e) {
    console.warn("DEV-CMD: failed to create log thread:", e?.message || String(e));
  }

  // Trigger GitHub Actions workflow_dispatch
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    const msg = "❌ `GITHUB_PAT` is not configured. Cannot trigger the dev agent workflow.";
    if (logThread) await logThread.send({ content: msg });
    else await interaction.editReply({ content: msg });
    return;
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            task,
            task_type: taskType,
            discord_user: interaction.user.username,
          },
        }),
      }
    );

    if (res.status === 204) {
      const actionsUrl = `https://github.com/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}`;
      const lines = [
        `🚀 **Dev agent triggered!**`,
        `**Requested by:** ${interaction.user.username}`,
        `**Type:** ${taskType}`,
        `**Task:** ${task}`,
        ``,
        `Claude Code is now working on this in GitHub Actions.`,
        `Results (PR link or status) will be posted here when done.`,
        `[View workflow runs](${actionsUrl})`,
      ];

      if (logThread) {
        await logThread.send({ content: lines.join("\n") });
        await interaction.editReply({
          content: `🚀 Dev agent dispatched! Follow progress in ${logThread}.`,
        });
      } else {
        await interaction.editReply({ content: lines.join("\n") });
      }
    } else {
      const body = await res.text();
      console.error("DEV-CMD: GitHub API error:", res.status, body);
      const msg = `❌ Failed to trigger workflow (HTTP ${res.status}). Check GITHUB_PAT permissions.`;
      if (logThread) await logThread.send({ content: msg });
      else await interaction.editReply({ content: msg });
    }
  } catch (err) {
    console.error("DEV-CMD: dispatch error:", err);
    const msg = `❌ Error triggering dev agent: ${err.message || String(err)}`;
    if (logThread) await logThread.send({ content: msg });
    else await interaction.editReply({ content: msg });
  }
}

import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("create-product")
    .setDescription("Create a Shopify draft product from an image")
    .addAttachmentOption(option =>
      option
        .setName("image")
        .setDescription("Upload a bottle image")
        .setRequired(true)
    )
    .addNumberOption(option =>
      option
        .setName("cost")
        .setDescription("Product cost")
        .setRequired(true)
    )
    .addNumberOption(option =>
      option
        .setName("price")
        .setDescription("Selling price")
        .setRequired(true)
    )
    .addNumberOption(option =>
      option
        .setName("abv")
        .setDescription("Optional ABV % (e.g., 53.5)")
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(false)
    )
    .addNumberOption(option =>
      option
        .setName("proof")
        .setDescription("Optional proof (e.g., 107). If provided, ABV will be computed as proof/2.")
        .setMinValue(0)
        .setMaxValue(200)
        .setRequired(false)
    )
    .addIntegerOption(option =>
      option
        .setName("quantity")
        .setDescription("Optional starting inventory quantity (e.g., 6)")
        .setMinValue(0)
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName("barcode")
        .setDescription("Optional barcode/UPC (digits only)")
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName("reference_link")
        .setDescription("Optional reference link (e.g., distillery page / distributor listing)")
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName("notes")
        .setDescription("Optional notes (store pick, barrel #, etc.)")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("tastingcard")
    .setDescription("Generate a tasting card for an existing Shopify product")
    .addStringOption(option =>
      option
        .setName("url")
        .setDescription("Shopify admin product URL (e.g., https://admin.shopify.com/store/xxx/products/123)")
        .setRequired(true)
    )
    .addBooleanOption(option =>
      option
        .setName("force")
        .setDescription("Regenerate even if a tasting card already exists")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("dev")
    .setDescription("Ask Claude to implement a feature, fix a bug, or refactor code")
    .addStringOption(option =>
      option
        .setName("task")
        .setDescription("Describe what you want done (10-500 chars)")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("type")
        .setDescription("Type of task")
        .setRequired(false)
        .addChoices(
          { name: "Feature", value: "feature" },
          { name: "Bugfix", value: "bugfix" },
          { name: "Refactor", value: "refactor" }
        )
    )
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function register() {
  try {
    console.log("📡 Registering slash command...");
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_APP_ID),
      { body: commands }
    );
    console.log("✅ Slash command registered!");
  } catch (error) {
    console.error(error);
  }
}

register();

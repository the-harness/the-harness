const commands = new Set(["install", "remove", "uninstall", "update", "list", "config"]);
const selfUpdateTargets = new Set(["self", "pi"]);
const updateTargets = new Set(["--extensions", "--extension", "--models"]);

export async function runPackageCommand(argv: readonly string[]): Promise<boolean> {
  const command = argv[0];
  if (!command || !commands.has(command)) return false;

  if (argv.includes("--offline")) {
    process.env["PI_OFFLINE"] = "1";
    process.env["PI_SKIP_VERSION_CHECK"] = "1";
  }
  const args = argv.filter((arg) => arg !== "--offline");
  if (command === "update") {
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`harness-pi update [source]
harness-pi update [--extensions | --extension <source> | --models] [--approve | --no-approve]

Updates installed Pi packages by default. Rebuild or reinstall the distribution to update harness-pi itself.`);
      return true;
    }
    const options = args.slice(1);
    const target = options.find(
      (arg, index) => !arg.startsWith("-") && options[index - 1] !== "--extension",
    );
    if (
      options.includes("--self") ||
      options.includes("--all") ||
      (target && selfUpdateTargets.has(target))
    ) {
      throw new Error("Rebuild or reinstall the distribution to update harness-pi itself");
    }
    if (!target && !options.some((arg) => updateTargets.has(arg))) args.push("--extensions");
  }

  // Pi v1.6.1 ships its resource management commands with the SDK.
  const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { handleConfigCommand, handlePackageCommand } = (await import(
    new URL("package-manager-cli.js", sdk).href
  )) as {
    handleConfigCommand(args: string[]): Promise<boolean>;
    handlePackageCommand(args: string[]): Promise<boolean>;
  };
  return command === "config" ? handleConfigCommand(args) : handlePackageCommand(args);
}

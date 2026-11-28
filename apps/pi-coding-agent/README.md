```sh
harness-pi [--print | --mode <text|json|rpc>] [--continue | --resume | --session <path|id> | --fork <path|id>] [--session-id <id>] [--name <name>] [--provider <name>] [--model <pattern>] [--models <patterns>] [--no-tools | --no-builtin-tools] [--tools <selection>] [--exclude-tools <patterns>] [--approve | --no-approve] [-e <source>] [--<extension-flag> [value]] [--] [@files...] [messages...]
harness-pi --list-models [search]
harness-pi --export <file> [output]
harness-pi install <source> [-l]
harness-pi remove <source> [-l]
harness-pi update [source | --extensions | --models]
harness-pi list
harness-pi config [-l]
harness-pi mcp <add|remove|list|login|logout> [options]
harness-pi auth <login|logout|check|print-api-key|print-bearer-token> [options]
harness-pi --no-mcp [options] [messages...]
harness-pi [--skill <path>] [--no-skills] [--prompt-template <path>] [--no-prompt-templates] [--theme <path>] [--no-themes] [--use-theme <name>] [--no-context-files] [--offline] [--tui-mode <regular|fullscreen>] [--verbose]
pnpm --filter @harness/pi-coding-agent-cli pack:standalone [--target <darwin|linux|windows>-<arm64|x64>] [--out <directory>]
```

import { Command } from "commander";

export interface CliOptions {
  url: string;
  output: string;
  verbose: boolean;
  includeNodeModules: boolean;
  concurrency: number;
}

export function parseArgs(): CliOptions {
  const program = new Command();

  program
    .name("top-secret-source-reverse-engineerer-9001")
    .description(
      "Extract and reconstruct original source code from publicly available source maps"
    )
    .version("1.0.0")
    .argument("<url>", "URL of the website to extract source maps from")
    .option("-o, --output <dir>", "Output directory", "./output")
    .option("-v, --verbose", "Enable verbose logging", false)
    .option(
      "-n, --include-node-modules",
      "Include node_modules in output",
      false
    )
    .option(
      "-c, --concurrency <number>",
      "Number of concurrent downloads",
      "5"
    )
    .parse();

  const options = program.opts();
  const [url] = program.args;

  return {
    url,
    output: options.output,
    verbose: options.verbose,
    includeNodeModules: options.includeNodeModules,
    concurrency: parseInt(options.concurrency, 10),
  };
}

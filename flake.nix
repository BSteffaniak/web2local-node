{
  description = "web2local - Reverse-engineer web apps from deployed bundles";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Node.js environment
            nodejs_20
            pnpm

            # Git
            git
            
            # Playwright with browsers from nixpkgs
            playwright-driver.browsers
            
            # Virtual framebuffer for headless browser support
            xvfb-run
          ];

          # Point Playwright to nixpkgs browsers instead of downloading its own
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          
          # Skip browser download since we're using nixpkgs browsers
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

          shellHook = ''
            echo ""
            echo "  web2local Dev Shell"
            echo "  ───────────────────"
            echo ""
            echo "  Node.js: $(node --version)"
            echo "  pnpm:    $(pnpm --version)"
            echo ""
            echo "  Playwright browsers provided by nixpkgs (no download needed)"
            echo ""
            echo "  Setup:"
            echo "    1. pnpm install"
            echo "    2. pnpm build"
            echo ""
            echo "  Usage:"
            echo "    pnpm cli <url>"
            echo ""
          '';
        };
      }
    );
}

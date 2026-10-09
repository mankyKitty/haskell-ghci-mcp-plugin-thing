{
  description = "ghci-mcp: a long-lived GHCi session for MCP agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
    in
    {
      packages = forAllSystems (pkgs: rec {
        ghci-mcp = pkgs.buildNpmPackage {
          pname = "ghci-mcp";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let base = baseNameOf path; in
              !(builtins.elem base [ "node_modules" "dist" ".ghci-mcp" "result" ]);
          };

          nodejs = pkgs.nodejs_22;

          # Hash of the npm dependency tree described by package-lock.json.
          # First build: leave as lib.fakeHash, run `nix build`, copy the
          # "got: sha256-..." value from the error here. Re-do this whenever
          # package-lock.json changes. (Or: nix run nixpkgs#prefetch-npm-deps -- package-lock.json)
          npmDepsHash = pkgs.lib.fakeHash;

          # The lockfile was produced with --legacy-peer-deps (npm 10 arborist
          # bug with vitest's peers); npm ci needs the same flag to accept it.
          npmFlags = [ "--legacy-peer-deps" ];
          npmBuildScript = "build";

          # vitest is a devDependency; tests run in `nix flake check`, not here.
          doCheck = false;

          meta = with pkgs.lib; {
            description = "Give Claude (or any MCP agent) a long-lived GHCi session for typechecking, evaluating and testing Haskell";
            license = licenses.mit;
            mainProgram = "ghci-mcp";
            platforms = platforms.unix;
          };
        };
        default = ghci-mcp;
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.system}.ghci-mcp}/bin/ghci-mcp";
        };
      });

      # `nix flake check` runs the full test suite against a real GHCi.
      checks = forAllSystems (pkgs: {
        tests = self.packages.${pkgs.system}.ghci-mcp.overrideAttrs (old: {
          doCheck = true;
          nativeCheckInputs = (old.nativeCheckInputs or [ ]) ++ [ pkgs.ghc ];
          checkPhase = ''
            runHook preCheck
            export HOME=$TMPDIR
            npx vitest run
            runHook postCheck
          '';
        });
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            typescript
            ghc
            cabal-install
            haskell-language-server
          ];
          shellHook = ''
            export PATH="$PWD/node_modules/.bin:$PATH"
            echo "ghci-mcp dev shell: node $(node --version), $(ghc --numeric-version | sed 's/^/ghc /'), cabal $(cabal --numeric-version)"
            echo "  npm install --legacy-peer-deps && npm test"
          '';
        };
      });
    };
}

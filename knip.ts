import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignoreBinaries: ["ps"],
  ignoreDependencies: ["lefthook"],
  workspaces: {
    "apps/crawler": {
      ignore: ["src/hooks/helpers.ts"],
    },
    "apps/web": {
      entry: ["e2e/mock-crawler-server.ts"],
    },
    "packages/db": {
      entry: ["src/migrate.ts"],
    },
  },
};

export default config;

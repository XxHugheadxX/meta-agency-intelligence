import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

describe("Private product release guardrails", () => {
  it("requires manual dispatch, main and explicit production opt-in", () => {
    const deploy = source(".github/workflows/deploy.yml");
    const trigger = deploy.slice(deploy.indexOf("on:"), deploy.indexOf("\nenv:"));
    expect(trigger).toMatch(/workflow_dispatch:/);
    expect(trigger).not.toMatch(/\b(?:push|pull_request|schedule):/);
    expect(deploy).toMatch(/  deploy:\n    if: github\.ref == 'refs\/heads\/main' && vars\.ENABLE_PRODUCTION_DEPLOY == 'true'\n    needs: preflight/);
    expect(deploy).toMatch(/name: production/);
  });

  it("requires opt-in for release creation and dependent package publication", () => {
    const deploy = source(".github/workflows/deploy.yml");
    expect(deploy).toMatch(/  release:\n    if: vars\.ENABLE_PACKAGE_PUBLICATION == 'true'/);
    const publish = source(".github/workflows/publish.yml");
    expect(publish).toMatch(/  preflight:\n    if: vars\.ENABLE_PACKAGE_PUBLICATION == 'true'/);
    for (const job of ["npm", "ghcr"]) {
      const block = publish.split(`\n  ${job}:\n`)[1]?.split(/\n  \w+:\n/)[0];
      expect(block).toMatch(/needs: preflight/);
    }
  });

  it("copies only production dependencies to the non-root runtime stage", () => {
    const docker = source("Dockerfile");
    expect(docker).toMatch(/AS production-dependencies[\s\S]*?--omit=dev --ignore-scripts/);
    const runtime = docker.split("AS runtime")[1];
    expect(runtime).toContain("COPY --from=production-dependencies /app/node_modules/ node_modules/");
    expect(runtime).not.toContain("COPY --from=builder /app/node_modules/");
    expect(runtime).toContain("USER node");
  });
});

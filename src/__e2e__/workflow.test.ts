import { describe, test, expect } from "bun:test";
import { load } from "js-yaml";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..");
const E2E_WORKFLOW = join(ROOT, ".github", "workflows", "e2e.yml");
const CI_WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Workflow = Record<string, any>;

function loadWorkflow(path: string): Workflow {
  const raw = readFileSync(path, "utf8");
  return load(raw) as Workflow;
}

describe("e2e.yml workflow structure", () => {
  test("file exists", () => {
    expect(existsSync(E2E_WORKFLOW)).toBe(true);
  });

  test("has workflow_dispatch trigger", () => {
    const wf = loadWorkflow(E2E_WORKFLOW);
    expect(wf.on).toHaveProperty("workflow_dispatch");
  });

  test("has push trigger on v* tags", () => {
    const wf = loadWorkflow(E2E_WORKFLOW);
    const tags: string[] = wf.on?.push?.tags ?? [];
    expect(tags.some((t) => t === "v*")).toBe(true);
  });

  test("has a step that runs bun test src/__e2e__/", () => {
    const wf = loadWorkflow(E2E_WORKFLOW);
    const jobs: Workflow = wf.jobs ?? {};
    const allSteps = Object.values(jobs).flatMap(
      (job: Workflow) => (job.steps as Workflow[]) ?? [],
    );
    const hasE2eStep = allSteps.some(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("bun test src/__e2e__/"),
    );
    expect(hasE2eStep).toBe(true);
  });

  test("has a step that builds the binary before running e2e tests", () => {
    const wf = loadWorkflow(E2E_WORKFLOW);
    const jobs: Workflow = wf.jobs ?? {};
    const allSteps = Object.values(jobs).flatMap(
      (job: Workflow) => (job.steps as Workflow[]) ?? [],
    );
    const buildIdx = allSteps.findIndex(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("bun build --compile") &&
        step.run.includes("dist/protondrive"),
    );
    const e2eIdx = allSteps.findIndex(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("bun test src/__e2e__/"),
    );
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(e2eIdx).toBeGreaterThan(buildIdx);
  });

  test("build step targets bun-linux-x64", () => {
    const wf = loadWorkflow(E2E_WORKFLOW);
    const jobs: Workflow = wf.jobs ?? {};
    const allSteps = Object.values(jobs).flatMap(
      (job: Workflow) => (job.steps as Workflow[]) ?? [],
    );
    const buildStep = allSteps.find(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("bun build --compile") &&
        step.run.includes("dist/protondrive"),
    );
    expect(buildStep).toBeDefined();
    expect(buildStep!.run).toContain("--target=bun-linux-x64");
  });

  test("integration test step passes PROTON_TEST_USER from secrets", () => {
    const wf = loadWorkflow(E2E_WORKFLOW);
    const jobs: Workflow = wf.jobs ?? {};
    const allSteps = Object.values(jobs).flatMap(
      (job: Workflow) => (job.steps as Workflow[]) ?? [],
    );
    const integStep = allSteps.find(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("bun test src/__integration__/"),
    );
    expect(integStep).toBeDefined();
    const envUser: string = integStep?.env?.PROTON_TEST_USER ?? "";
    expect(envUser).toContain("secrets.PROTON_TEST_USER");
  });

  test("integration test step passes PROTON_TEST_PASS from secrets", () => {
    const wf = loadWorkflow(E2E_WORKFLOW);
    const jobs: Workflow = wf.jobs ?? {};
    const allSteps = Object.values(jobs).flatMap(
      (job: Workflow) => (job.steps as Workflow[]) ?? [],
    );
    const integStep = allSteps.find(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("bun test src/__integration__/"),
    );
    expect(integStep).toBeDefined();
    const envPass: string = integStep?.env?.PROTON_TEST_PASS ?? "";
    expect(envPass).toContain("secrets.PROTON_TEST_PASS");
  });

  test("integration test step only runs on push event (not workflow_dispatch)", () => {
    const wf = loadWorkflow(E2E_WORKFLOW);
    const jobs: Workflow = wf.jobs ?? {};
    const allSteps = Object.values(jobs).flatMap(
      (job: Workflow) => (job.steps as Workflow[]) ?? [],
    );
    const integStep = allSteps.find(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("bun test src/__integration__/"),
    );
    expect(integStep).toBeDefined();
    const condition: string = integStep?.if ?? "";
    expect(condition).toContain("push");
  });

  test("all uses: fields are pinned to commit SHAs, not mutable tags", () => {
    const wf = loadWorkflow(E2E_WORKFLOW);
    const jobs: Workflow = wf.jobs ?? {};
    const allSteps = Object.values(jobs).flatMap(
      (job: Workflow) => (job.steps as Workflow[]) ?? [],
    );
    const shaPattern = /^[^@]+@[0-9a-f]{40}(\s|$)/;
    const stepsWithUses = allSteps.filter(
      (step) => typeof step.uses === "string",
    );
    expect(stepsWithUses.length).toBeGreaterThan(0);
    for (const step of stepsWithUses) {
      expect(
        shaPattern.test(step.uses as string),
        `Expected SHA-pinned uses, got: ${step.uses}`,
      ).toBe(true);
    }
  });
});

describe("ci.yml unchanged by story 7-3", () => {
  test("ci.yml does not run integration tests", () => {
    const raw = readFileSync(CI_WORKFLOW, "utf8");
    expect(raw).not.toContain("src/__integration__/");
  });

  test("ci.yml still runs bun test (unit tests)", () => {
    const raw = readFileSync(CI_WORKFLOW, "utf8");
    expect(raw).toContain("bun test");
  });
});

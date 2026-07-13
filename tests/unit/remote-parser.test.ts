import { describe, expect, test } from "bun:test";
import { ReviewerError } from "../../src/domain/errors.ts";
import { knownProviderForHost, parseRemoteUrl } from "../../src/repository/remote-parser.ts";

describe("remote parser", () => {
  test("parses GitHub HTTPS remotes", () => {
    expect(parseRemoteUrl("https://github.com/acme/project.git")).toEqual({
      host: "github.com",
      owner: "acme",
      name: "project",
      remote: "https://github.com/acme/project.git",
    });
  });

  test("parses SCP-style nested GitLab groups", () => {
    expect(parseRemoteUrl("git@gitlab.example.com:platform/security/project.git")).toEqual({
      host: "gitlab.example.com",
      owner: "platform/security",
      name: "project",
      remote: "git@gitlab.example.com:platform/security/project.git",
    });
  });

  test("parses SSH URLs", () => {
    expect(parseRemoteUrl("ssh://git@ghe.example.test/company/repo.git")).toMatchObject({
      host: "ghe.example.test",
      owner: "company",
      name: "repo",
    });
  });

  test("maps only known public hosts without authentication metadata", () => {
    expect(knownProviderForHost("github.com")).toBe("github");
    expect(knownProviderForHost("gitlab.com")).toBe("gitlab");
    expect(knownProviderForHost("code.example.com")).toBeNull();
  });

  test("rejects local paths and unsupported schemes", () => {
    expect(() => parseRemoteUrl("file:///tmp/repo.git")).toThrow(ReviewerError);
  });
});

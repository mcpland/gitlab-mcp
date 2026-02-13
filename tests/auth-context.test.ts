import { describe, expect, it } from "vitest";

import { getSessionAuth, runWithSessionAuth, type SessionAuth } from "../src/lib/auth-context.js";

describe("auth-context", () => {
  describe("runWithSessionAuth", () => {
    it("provides auth data within callback", () => {
      const auth: SessionAuth = {
        sessionId: "sess-1",
        token: "my-token",
        apiUrl: "https://gitlab.example.com/api/v4",
        header: "private-token",
        updatedAt: Date.now()
      };

      runWithSessionAuth(auth, () => {
        const retrieved = getSessionAuth();
        expect(retrieved).toEqual(auth);
      });
    });

    it("returns undefined outside of context", () => {
      expect(getSessionAuth()).toBeUndefined();
    });

    it("supports undefined auth", () => {
      runWithSessionAuth(undefined, () => {
        expect(getSessionAuth()).toBeUndefined();
      });
    });

    it("returns the callback result", () => {
      const result = runWithSessionAuth(undefined, () => "hello");
      expect(result).toBe("hello");
    });

    it("supports nested contexts", () => {
      const outerAuth: SessionAuth = {
        token: "outer-token",
        updatedAt: Date.now()
      };

      const innerAuth: SessionAuth = {
        token: "inner-token",
        updatedAt: Date.now()
      };

      runWithSessionAuth(outerAuth, () => {
        expect(getSessionAuth()?.token).toBe("outer-token");

        runWithSessionAuth(innerAuth, () => {
          expect(getSessionAuth()?.token).toBe("inner-token");
        });

        // Outer context is restored
        expect(getSessionAuth()?.token).toBe("outer-token");
      });
    });

    it("isolates context between concurrent async operations", async () => {
      const results: string[] = [];

      const task1 = new Promise<void>((resolve) => {
        runWithSessionAuth({ token: "token-a", updatedAt: 1 }, () => {
          setTimeout(() => {
            runWithSessionAuth({ token: "token-a", updatedAt: 1 }, () => {
              results.push(getSessionAuth()?.token ?? "none");
              resolve();
            });
          }, 10);
        });
      });

      const task2 = new Promise<void>((resolve) => {
        runWithSessionAuth({ token: "token-b", updatedAt: 2 }, () => {
          results.push(getSessionAuth()?.token ?? "none");
          resolve();
        });
      });

      await Promise.all([task1, task2]);

      expect(results).toContain("token-a");
      expect(results).toContain("token-b");
    });

    it("handles auth with minimal fields", () => {
      const auth: SessionAuth = {
        updatedAt: Date.now()
      };

      runWithSessionAuth(auth, () => {
        const retrieved = getSessionAuth();
        expect(retrieved?.token).toBeUndefined();
        expect(retrieved?.apiUrl).toBeUndefined();
        expect(retrieved?.header).toBeUndefined();
        expect(retrieved?.sessionId).toBeUndefined();
        expect(retrieved?.updatedAt).toBeDefined();
      });
    });
  });
});

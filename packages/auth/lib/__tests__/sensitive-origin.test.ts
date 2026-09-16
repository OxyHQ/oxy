/**
 * auth.oxy.so is where people sign in, consent and recover (ADR 0024 D1). It
 * runs no product analytics and serves a CSP that blocks the edge's analytics
 * beacon. These are properties of what is SHIPPED — the dependency graph, the
 * source tree and the header config — so they are checked there, not behind a
 * build flag that a variable could flip back on.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")

function sourceFiles(directory: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(directory)) {
        if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) found.push(...sourceFiles(path))
        else if (/\.(ts|tsx|html)$/.test(entry)) found.push(path)
    }
    return found
}

describe("auth.oxy.so is a sensitive origin", () => {
    test("depends on no analytics or session-replay package", () => {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
        const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
        expect(names.filter((name) => /posthog|segment|mixpanel|amplitude|hotjar|fullstory|logrocket|sentry\/replay|clarity/i.test(name))).toEqual([])
    })

    test("no shipped source wires product analytics", () => {
        const offenders = ["src", "components", "lib", "app", "hub", "functions", "index.html"]
            .map((entry) => join(root, entry))
            .flatMap((path) => {
                try {
                    return statSync(path).isDirectory() ? sourceFiles(path) : [path]
                } catch {
                    return []
                }
            })
            .filter((file) => /productAnalytics|posthog/i.test(readFileSync(file, "utf8")))
        expect(offenders).toEqual([])
    })

    test("its headers are built in sensitive mode, with no third-party connect sources", () => {
        const config = JSON.parse(readFileSync(join(root, "oxy.pages-headers.json"), "utf8")) as { sensitive?: boolean; csp?: Record<string, string[]> }
        expect(config.sensitive).toBe(true)
        expect(config.csp?.connectSrc ?? []).toEqual([])
    })
})

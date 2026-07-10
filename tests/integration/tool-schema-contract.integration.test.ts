import { readFileSync } from "node:fs";
import * as path from "node:path";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildContext, createLinkedPair } from "./_helpers.js";

interface ToolContract {
  schemaFields: Record<string, string>;
  requiredLookups: string[];
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const GITLAB_TOOLS_FILE = path.join(REPO_ROOT, "src", "tools", "gitlab.ts");
const MR_CODE_CONTEXT_FILE = path.join(REPO_ROOT, "src", "tools", "mr-code-context.ts");

describe("Tool schema contract", () => {
  let toolsByName = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        enableCompatibilityAliases: true,
        enableCiVariableTools: true
      })
    );

    try {
      const { tools } = await client.listTools();
      toolsByName = new Map(
        tools.map((tool) => [tool.name, tool.inputSchema as Record<string, unknown>])
      );
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  afterAll(() => {
    toolsByName.clear();
  });

  it("does not export optional or defaulted fields as required", () => {
    const contracts = loadToolContracts();

    for (const [toolName, contract] of contracts) {
      const jsonSchema = toolsByName.get(toolName);
      expect(jsonSchema, `Missing tool '${toolName}' in tools/list`).toBeDefined();

      const required = getRequiredFields(jsonSchema);

      for (const [fieldName, expression] of Object.entries(contract.schemaFields)) {
        if (!isOptionalOrDefaultExpression(expression)) {
          continue;
        }

        expect(
          required,
          `Expected '${toolName}.${fieldName}' to stay optional/defaulted in exported JSON Schema`
        ).not.toContain(fieldName);
      }
    }
  });

  it("exports handler-required fields as required or defaulted", () => {
    const contracts = loadToolContracts();

    for (const [toolName, contract] of contracts) {
      const jsonSchema = toolsByName.get(toolName);
      expect(jsonSchema, `Missing tool '${toolName}' in tools/list`).toBeDefined();

      const required = new Set(getRequiredFields(jsonSchema));
      const properties = getProperties(jsonSchema);

      for (const fieldName of contract.requiredLookups) {
        const propertySchema = properties[fieldName];

        expect(
          propertySchema,
          `Expected '${toolName}.${fieldName}' to be present in exported JSON Schema`
        ).toBeDefined();
        expect(
          required.has(fieldName) || hasDefault(propertySchema),
          `Expected '${toolName}.${fieldName}' to be exported as required or carry a default`
        ).toBe(true);
      }
    }
  });
});

function loadToolContracts(): Map<string, ToolContract> {
  const sharedShapes = new Map<string, Record<string, string>>([
    ...collectSchemaShapes(GITLAB_TOOLS_FILE),
    ...collectSchemaShapes(MR_CODE_CONTEXT_FILE)
  ]);
  const source = readFileSync(GITLAB_TOOLS_FILE, "utf8");
  const sourceFile = ts.createSourceFile(
    GITLAB_TOOLS_FILE,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const contracts = new Map<string, ToolContract>();

  visit(sourceFile, (node) => {
    if (!ts.isObjectLiteralExpression(node)) {
      return;
    }

    const name = getStringLiteralProperty(node, "name");
    const handler = getPropertyInitializer(node, "handler");
    if (!name || !handler) {
      return;
    }

    const inputSchema = getPropertyInitializer(node, "inputSchema");
    const schemaFields = resolveSchemaFields(inputSchema, sharedShapes, source);
    const requiredLookups = collectRequiredLookups(handler, source);

    contracts.set(name, {
      schemaFields,
      requiredLookups
    });
  });

  return contracts;
}

function collectSchemaShapes(filePath: string): Map<string, Record<string, string>> {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const shapes = new Map<string, Record<string, string>>();

  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
      return;
    }

    if (!ts.isObjectLiteralExpression(node.initializer)) {
      return;
    }

    shapes.set(node.name.text, extractSchemaFields(node.initializer, shapes, source));
  });

  return shapes;
}

function resolveSchemaFields(
  node: ts.Expression | undefined,
  sharedShapes: Map<string, Record<string, string>>,
  source: string
): Record<string, string> {
  if (!node) {
    return {};
  }

  if (ts.isObjectLiteralExpression(node)) {
    return extractSchemaFields(node, sharedShapes, source);
  }

  if (ts.isIdentifier(node)) {
    return sharedShapes.get(node.text) ?? {};
  }

  return {};
}

function extractSchemaFields(
  objectLiteral: ts.ObjectLiteralExpression,
  sharedShapes: Map<string, Record<string, string>>,
  source: string
): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
      Object.assign(fields, sharedShapes.get(property.expression.text) ?? {});
      continue;
    }

    if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) {
      continue;
    }

    const key = getPropertyName(property.name);
    if (!key) {
      continue;
    }

    fields[key] = getNodeText(
      ts.isPropertyAssignment(property) ? property.initializer : property.name,
      source
    );
  }

  return fields;
}

function collectRequiredLookups(handler: ts.Expression, source: string): string[] {
  const required = new Set<string>();

  visit(handler, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }

    if (node.expression.text !== "getString" && node.expression.text !== "getBoolean") {
      return;
    }

    const keyArg = node.arguments[1];
    if (keyArg && ts.isStringLiteral(keyArg)) {
      required.add(getNodeText(keyArg, source).slice(1, -1));
    }
  });

  return [...required];
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function getPropertyInitializer(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string
): ts.Expression | undefined {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) || !property.name) {
      continue;
    }

    if (getPropertyName(property.name) === propertyName) {
      return property.initializer;
    }
  }

  return undefined;
}

function getStringLiteralProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string
): string | undefined {
  const initializer = getPropertyInitializer(objectLiteral, propertyName);
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
}

function getPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function getNodeText(node: ts.Node, source: string): string {
  return source.slice(node.getStart(), node.getEnd());
}

function isOptionalOrDefaultExpression(expression: string): boolean {
  return (
    /^optional[A-Z]/.test(expression) ||
    /\.optional\(/.test(expression) ||
    /\.default\(/.test(expression)
  );
}

function getRequiredFields(jsonSchema: Record<string, unknown> | undefined): string[] {
  const required = jsonSchema?.required;
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === "string")
    : [];
}

function getProperties(
  jsonSchema: Record<string, unknown> | undefined
): Record<string, Record<string, unknown>> {
  const properties = jsonSchema?.properties;
  if (!properties || typeof properties !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(properties).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        typeof entry[0] === "string" &&
        typeof entry[1] === "object" &&
        entry[1] !== null &&
        !Array.isArray(entry[1])
    )
  );
}

function hasDefault(propertySchema: Record<string, unknown> | undefined): boolean {
  return propertySchema !== undefined && Object.hasOwn(propertySchema, "default");
}

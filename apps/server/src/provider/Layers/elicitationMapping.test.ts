import { describe, expect, it } from "vitest";

import {
  mapElicitationToUserInputQuestions,
  mapAnswersToElicitationContent,
  mapAskUserQuestionToUserInputQuestions,
} from "./ClaudeCodeAdapter.ts";

describe("mapElicitationToUserInputQuestions", () => {
  it("returns single free-text question when no schema", () => {
    const result = mapElicitationToUserInputQuestions({
      serverName: "test-server",
      message: "Enter your API key",
    });

    expect(result).toEqual([
      {
        id: "elicitation",
        header: "MCP: test-server",
        question: "Enter your API key",
        options: [],
      },
    ]);
  });

  it("returns single free-text question when schema has no properties", () => {
    const result = mapElicitationToUserInputQuestions({
      serverName: "test-server",
      message: "Provide input",
      requestedSchema: { type: "object" },
    });

    expect(result).toEqual([
      {
        id: "elicitation",
        header: "MCP: test-server",
        question: "Provide input",
        options: [],
      },
    ]);
  });

  it("maps flat schema with string properties to free-text questions", () => {
    const result = mapElicitationToUserInputQuestions({
      serverName: "auth-server",
      message: "Configure auth",
      requestedSchema: {
        type: "object",
        properties: {
          username: { type: "string", description: "Your username" },
          password: { type: "string", description: "Your password" },
        },
      },
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "username",
      header: "MCP: auth-server",
      question: "Your username",
      options: [],
    });
    expect(result[1]).toEqual({
      id: "password",
      header: "MCP: auth-server",
      question: "Your password",
      options: [],
    });
  });

  it("maps enum values to option buttons", () => {
    const result = mapElicitationToUserInputQuestions({
      serverName: "config-server",
      message: "Choose environment",
      requestedSchema: {
        type: "object",
        properties: {
          env: {
            type: "string",
            description: "Target environment",
            enum: ["dev", "staging", "production"],
          },
        },
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("env");
    expect(result[0]!.options).toEqual([
      { label: "dev", description: "dev" },
      { label: "staging", description: "staging" },
      { label: "production", description: "production" },
    ]);
  });

  it("uses property key as question when no description or title", () => {
    const result = mapElicitationToUserInputQuestions({
      serverName: "server",
      message: "msg",
      requestedSchema: {
        type: "object",
        properties: {
          apiKey: { type: "string" },
        },
      },
    });

    expect(result[0]!.question).toBe("apiKey");
  });

  it("uses title when description is absent", () => {
    const result = mapElicitationToUserInputQuestions({
      serverName: "server",
      message: "msg",
      requestedSchema: {
        type: "object",
        properties: {
          token: { type: "string", title: "Auth Token" },
        },
      },
    });

    expect(result[0]!.question).toBe("Auth Token");
  });

  it("falls back to single free-text for complex schemas (oneOf)", () => {
    const result = mapElicitationToUserInputQuestions({
      serverName: "complex",
      message: "Complex input",
      requestedSchema: {
        type: "object",
        properties: {
          value: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("elicitation");
    expect(result[0]!.question).toBe("Complex input");
  });

  it("falls back to single free-text for nested object properties", () => {
    const result = mapElicitationToUserInputQuestions({
      serverName: "nested",
      message: "Nested input",
      requestedSchema: {
        type: "object",
        properties: {
          config: { type: "object", properties: { nested: { type: "string" } } },
        },
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("elicitation");
  });

  it("falls back to single free-text for array properties", () => {
    const result = mapElicitationToUserInputQuestions({
      serverName: "arr",
      message: "Array input",
      requestedSchema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string" } },
        },
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("elicitation");
  });

  it("maps boolean properties as free-text (no enum)", () => {
    const result = mapElicitationToUserInputQuestions({
      serverName: "server",
      message: "msg",
      requestedSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "Enable feature?" },
        },
      },
    });

    expect(result[0]!.options).toEqual([]);
    expect(result[0]!.question).toBe("Enable feature?");
  });
});

describe("mapAnswersToElicitationContent", () => {
  it("passes through answers unchanged when no schema", () => {
    const result = mapAnswersToElicitationContent({ name: "Alice", age: "30" }, undefined);

    expect(result).toEqual({ name: "Alice", age: "30" });
  });

  it("passes through answers when schema has no properties", () => {
    const result = mapAnswersToElicitationContent({ name: "Alice" }, { type: "object" });

    expect(result).toEqual({ name: "Alice" });
  });

  it("coerces string to boolean", () => {
    const result = mapAnswersToElicitationContent(
      { enabled: "true", disabled: "false" },
      {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          disabled: { type: "boolean" },
        },
      },
    );

    expect(result.enabled).toBe(true);
    expect(result.disabled).toBe(false);
  });

  it("coerces string to number", () => {
    const result = mapAnswersToElicitationContent(
      { port: "8080", ratio: "3.14" },
      {
        type: "object",
        properties: {
          port: { type: "integer" },
          ratio: { type: "number" },
        },
      },
    );

    expect(result.port).toBe(8080);
    expect(result.ratio).toBe(3.14);
  });

  it("falls back to string when number parse fails", () => {
    const result = mapAnswersToElicitationContent(
      { port: "not-a-number" },
      {
        type: "object",
        properties: {
          port: { type: "number" },
        },
      },
    );

    expect(result.port).toBe("not-a-number");
  });

  it("does not coerce non-string values", () => {
    const result = mapAnswersToElicitationContent(
      { enabled: true, count: 42 },
      {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          count: { type: "number" },
        },
      },
    );

    expect(result.enabled).toBe(true);
    expect(result.count).toBe(42);
  });

  it("passes through string values for string-typed properties", () => {
    const result = mapAnswersToElicitationContent(
      { name: "Alice" },
      {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      },
    );

    expect(result.name).toBe("Alice");
  });

  it("passes through unknown property keys not in schema", () => {
    const result = mapAnswersToElicitationContent(
      { unknown: "value" },
      {
        type: "object",
        properties: {
          known: { type: "string" },
        },
      },
    );

    expect(result.unknown).toBe("value");
  });
});

describe("mapAskUserQuestionToUserInputQuestions", () => {
  it("maps questions with options from AskUserQuestion input", () => {
    const result = mapAskUserQuestionToUserInputQuestions({
      questions: [
        {
          question: "Which library should we use?",
          header: "Library",
          options: [
            { label: "lodash", description: "Utility library" },
            { label: "ramda", description: "Functional library" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("Which library should we use?");
    expect(result[0]!.header).toBe("Library");
    expect(result[0]!.question).toBe("Which library should we use?");
    expect(result[0]!.options).toEqual([
      { label: "lodash", description: "Utility library" },
      { label: "ramda", description: "Functional library" },
    ]);
  });

  it("maps multiple questions", () => {
    const result = mapAskUserQuestionToUserInputQuestions({
      questions: [
        {
          question: "Auth method?",
          header: "Auth",
          options: [
            { label: "JWT", description: "Token-based" },
            { label: "OAuth", description: "Delegated auth" },
          ],
        },
        {
          question: "Database?",
          header: "DB",
          options: [
            { label: "PostgreSQL", description: "Relational" },
            { label: "MongoDB", description: "Document store" },
          ],
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("Auth method?");
    expect(result[1]!.id).toBe("Database?");
  });

  it("returns fallback for empty questions array", () => {
    const result = mapAskUserQuestionToUserInputQuestions({ questions: [] });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("question");
    expect(result[0]!.options).toEqual([]);
  });

  it("returns fallback when questions field is missing", () => {
    const result = mapAskUserQuestionToUserInputQuestions({});

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("question");
  });

  it("filters out options with empty labels", () => {
    const result = mapAskUserQuestionToUserInputQuestions({
      questions: [
        {
          question: "Pick one",
          header: "Choice",
          options: [
            { label: "valid", description: "good" },
            { label: "", description: "bad" },
          ],
        },
      ],
    });

    expect(result[0]!.options).toHaveLength(1);
    expect(result[0]!.options[0]!.label).toBe("valid");
  });

  it("uses question text as id for answer key matching", () => {
    const questionText = "Which approach do you prefer?";
    const result = mapAskUserQuestionToUserInputQuestions({
      questions: [
        {
          question: questionText,
          header: "Approach",
          options: [
            { label: "A", description: "Option A" },
            { label: "B", description: "Option B" },
          ],
        },
      ],
    });

    expect(result[0]!.id).toBe(questionText);
  });
});

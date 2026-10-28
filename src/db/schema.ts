import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { FileImportInfo, ProjectStats, SkippedInfo } from "@/lib/shared";
import type { ParamInfo, SymbolMetrics } from "@/lib/analysis/types";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sourceType: text("source_type").notNull(),
  sourcePath: text("source_path"),
  scannedAt: integer("scanned_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("ready"),
  fileCount: integer("file_count").notNull().default(0),
  symbolCount: integer("symbol_count").notNull().default(0),
  totalBytes: integer("total_bytes").notNull().default(0),
  languages: text("languages", { mode: "json" }).$type<Record<string, number>>().notNull().default({}),
  skipped: text("skipped", { mode: "json" }).$type<SkippedInfo>().notNull().default({ counts: {}, samples: [] }),
  stats: text("stats", { mode: "json" }).$type<ProjectStats>(),
  warnings: text("warnings", { mode: "json" }).$type<string[]>().notNull().default([]),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(sql`(cast(strftime('%s', 'now') as integer) * 1000)`).notNull(),
});

// Additive tables also initialized for existing local databases by learning-store.
export const projectScanVersions = sqliteTable("project_scan_versions", {
  projectId: integer("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(1),
});
export const learningBookmarks = sqliteTable("learning_bookmarks", {
  id: text("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  anchorKey: text("anchor_key").notNull(),
  anchor: text("anchor").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("learning_bookmarks_owner_idx").on(t.projectId, t.anchorKey)]);

export const learningNotes = sqliteTable("learning_notes", {
  id: text("id").primaryKey(), projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(), body: text("body").notNull(), tags: text("tags").notNull(), status: text("status").notNull(),
  version: integer("version").notNull(), anchor: text("anchor"), quote: text("quote"), deletedAt: integer("deleted_at"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (t) => [index("learning_notes_project_idx").on(t.projectId, t.deletedAt, t.updatedAt)]);

// Keyed by project-relative path so rescanning files does not remove their notes.
export const fileNotes = sqliteTable("file_notes", {
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  path: text("path").notNull(), body: text("body").notNull(), version: integer("version").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.path] })]);

export const noteMedia = sqliteTable("note_media", {
  id: text("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), data: text("data").notNull(),
});

export const learningNoteLinks = sqliteTable("learning_note_links", {
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull().references(() => learningNotes.id, { onDelete: "cascade" }),
  targetId: text("target_id").notNull().references(() => learningNotes.id, { onDelete: "cascade" }), label: text("label").notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.sourceId, t.targetId] }), index("learning_note_links_target_idx").on(t.projectId, t.targetId)]);
export const learningNoteEvidence = sqliteTable("learning_note_evidence", {
  noteId: text("note_id").primaryKey().references(() => learningNotes.id, { onDelete: "cascade" }), anchor: text("anchor").notNull(),
});
export const learningNoteImports = sqliteTable("learning_note_imports", {
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull(), fingerprint: text("fingerprint").notNull(),
  noteId: text("note_id").notNull().references(() => learningNotes.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.projectId, t.sourceId, t.fingerprint] })]);

export const files = sqliteTable(
  "files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    language: text("language").notNull(),
    size: integer("size").notNull(),
    lineCount: integer("line_count").notNull(),
    content: text("content").notNull(),
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
    hasSyntaxErrors: integer("has_syntax_errors", { mode: "boolean" }).notNull().default(false),
    imports: text("imports", { mode: "json" }).$type<FileImportInfo[]>().notNull().default([]),
  },
  (t) => [index("files_project_idx").on(t.projectId)],
);

export const symbols = sqliteTable(
  "symbols",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    parentId: integer("parent_id"),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    qualifiedName: text("qualified_name").notNull(),
    container: text("container"),
    isAsync: integer("is_async", { mode: "boolean" }).notNull().default(false),
    isGenerator: integer("is_generator", { mode: "boolean" }).notNull().default(false),
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
    signature: text("signature").notNull(),
    params: text("params", { mode: "json" }).$type<ParamInfo[]>().notNull().default([]),
    decorators: text("decorators", { mode: "json" }).$type<string[]>().notNull().default([]),
    docstring: text("docstring"),
    returnType: text("return_type"),
    bases: text("bases", { mode: "json" }).$type<string[]>().notNull().default([]),
    startLine: integer("start_line").notNull(),
    startCol: integer("start_col").notNull(),
    endLine: integer("end_line").notNull(),
    endCol: integer("end_col").notNull(),
    startIndex: integer("start_index").notNull(),
    endIndex: integer("end_index").notNull(),
    defStartIndex: integer("def_start_index").notNull(),
    defEndIndex: integer("def_end_index").notNull(),
    metrics: text("metrics", { mode: "json" }).$type<SymbolMetrics>().notNull(),
    aiExplanation: text("ai_explanation"),
    aiModel: text("ai_model"),
    aiGeneratedAt: integer("ai_generated_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("symbols_project_idx").on(t.projectId), index("symbols_file_idx").on(t.fileId), index("symbols_name_idx").on(t.projectId, t.name)],
);

export const symbolExplanations = sqliteTable("symbol_explanations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbolId: integer("symbol_id").notNull().references(() => symbols.id, { onDelete: "cascade" }),
  backend: text("backend").notNull(),
  configKey: text("config_key").notNull(),
  content: text("content").notNull(),
  model: text("model").notNull(),
  generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [uniqueIndex("symbol_explanations_config_idx").on(t.symbolId, t.backend, t.configKey)]);

// Project-scoped identity survives symbol/file replacement during rescans.
export const symbolQuestions = sqliteTable("symbol_questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  identity: text("identity").notNull(), backend: text("backend").notNull(),
  requestId: text("request_id").notNull(), fingerprint: text("fingerprint").notNull(),
  question: text("question").notNull(), quote: text("quote", { mode: "json" }).$type<import("@/lib/question-types").QuestionQuote | null>(),
  sources: text("sources", { mode: "json" }).$type<import("@/lib/question-types").QuestionSource[]>().notNull(),
  answer: text("answer"), status: text("status").notNull(), model: text("model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [index("symbol_questions_owner_idx").on(t.projectId, t.identity, t.backend), uniqueIndex("symbol_questions_request_idx").on(t.projectId, t.requestId)]);

export const refs = sqliteTable(
  "refs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerSymbolId: integer("owner_symbol_id")
      .notNull()
      .references(() => symbols.id, { onDelete: "cascade" }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name"),
    receiver: text("receiver"),
    calleeText: text("callee_text").notNull(),
    line: integer("line").notNull(),
    col: integer("col").notNull(),
    endLine: integer("end_line").notNull(),
    endCol: integer("end_col").notNull(),
    resolution: text("resolution").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [index("refs_owner_idx").on(t.ownerSymbolId), index("refs_project_idx").on(t.projectId)],
);

export const refTargets = sqliteTable(
  "ref_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    refId: integer("ref_id")
      .notNull()
      .references(() => refs.id, { onDelete: "cascade" }),
    targetSymbolId: integer("target_symbol_id")
      .notNull()
      .references(() => symbols.id, { onDelete: "cascade" }),
    confidence: text("confidence").notNull(),
    score: real("score").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [index("ref_targets_ref_idx").on(t.refId), index("ref_targets_target_idx").on(t.targetSymbolId)],
);

export const testLinks = sqliteTable(
  "test_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    testSymbolId: integer("test_symbol_id")
      .notNull()
      .references(() => symbols.id, { onDelete: "cascade" }),
    targetSymbolId: integer("target_symbol_id")
      .notNull()
      .references(() => symbols.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    confidence: text("confidence").notNull(),
    score: real("score").notNull(),
    reason: text("reason").notNull(),
    viaSymbolId: integer("via_symbol_id"),
  },
  (t) => [index("test_links_test_idx").on(t.testSymbolId), index("test_links_target_idx").on(t.targetSymbolId)],
);

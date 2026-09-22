export { TypeScriptProjector, projectTypeScript, type ProjectOptions } from './typescript.ts';
export { ParseError, Parser, parseExpression, parseTypeScript, type ParseOptions } from './parse.ts';
export { TypeNames } from './names.ts';
export { PythonProjector, projectPython } from './python.ts';
export { RustProjector, projectRust } from './rust.ts';
export { projectDiff, structuralDiff, type ProjectionDiffEntry } from './diff.ts';
export { LspStreamDecoder, ProjectionLanguageServer, encodeLspMessage, type JsonRpcRequest, type JsonRpcResponse, type ProjectionDiagnostic, type ProjectionDocument } from './lsp.ts';
export { PROJECTION_COVERAGE, unsupportedProjectionKinds, type ProjectionSupport, type ProjectionTarget } from './coverage.ts';

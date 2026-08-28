import packageMetadata from '../package.json';

/** package.json is the release authority consumed by both CLI and lifecycle evidence. */
export const CORTEXTOS_VERSION: string = packageMetadata.version;

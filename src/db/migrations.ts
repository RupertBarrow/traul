import type { TraulDB } from "./database";
import { CHUNKER_VERSION } from "../lib/chunker";
import { getEmbedSettings } from "../lib/embed-config";
import * as log from "../lib/logger";
import { FRENCH_INDEX_VERSION } from "../lib/french-index";

export interface MigrationResult {
  chunksReset: boolean;
  embeddingsReset: boolean;
  syncCursorsReset: boolean;
}

export function runMigrations(db: TraulDB): MigrationResult {
  const result: MigrationResult = {
    chunksReset: false,
    embeddingsReset: false,
    syncCursorsReset: false,
  };

  const storedChunkerVersion = db.getMeta("chunker_version");
  const storedEmbedModel = db.getMeta("embed_model");
  const storedEmbedDims = db.getMeta("embed_dims");

  const { model: EMBED_MODEL, dims: EMBED_DIMS } = getEmbedSettings();
  const currentDims = String(EMBED_DIMS);

  // Chunker version change → reset chunks + embeddings + markdown cursors
  if (storedChunkerVersion !== null && storedChunkerVersion !== CHUNKER_VERSION) {
    log.info(`Chunker updated (v${storedChunkerVersion} → v${CHUNKER_VERSION}), rechunking on next sync...`);
    db.resetChunks();
    db.resetEmbeddings(EMBED_DIMS);
    db.resetSyncCursors("markdown");
    result.chunksReset = true;
    result.embeddingsReset = true;
    result.syncCursorsReset = true;
  }

  // Embed model or dims change → reset embeddings only
  if (
    !result.embeddingsReset &&
    storedEmbedModel !== null &&
    (storedEmbedModel !== EMBED_MODEL || storedEmbedDims !== currentDims)
  ) {
    const reason =
      storedEmbedModel !== EMBED_MODEL
        ? `model changed (${storedEmbedModel} → ${EMBED_MODEL})`
        : `dimensions changed (${storedEmbedDims} → ${currentDims})`;
    log.info(`Embedding ${reason}, re-embed with 'traul embed'...`);
    db.resetEmbeddings(EMBED_DIMS);
    result.embeddingsReset = true;
  }

  // Update stored values only if changed (avoid unnecessary writes that cause SQLITE_BUSY)
  if (storedChunkerVersion !== CHUNKER_VERSION) {
    db.setMeta("chunker_version", CHUNKER_VERSION);
  }
  if (storedEmbedModel !== EMBED_MODEL) {
    db.setMeta("embed_model", EMBED_MODEL);
  }
  if (storedEmbedDims !== currentDims) {
    db.setMeta("embed_dims", currentDims);
  }

  // French keyword index: rebuilt when its stemming changes, and completed for messages an older traul wrote
  const storedFrench = db.getMeta("french_index_version");
  if (storedFrench !== null && storedFrench !== FRENCH_INDEX_VERSION) {
    log.info(`French index updated (v${storedFrench} → v${FRENCH_INDEX_VERSION}), rebuilding...`);
    db.resetFrench();
  }
  while (db.indexMissingFrench() > 0);
  if (storedFrench !== FRENCH_INDEX_VERSION) {
    db.setMeta("french_index_version", FRENCH_INDEX_VERSION);
  }

  return result;
}

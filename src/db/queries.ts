export const UPSERT_MESSAGE = `
  INSERT INTO messages (source, source_id, channel_id, channel_name, thread_id, author_id, author_name, content, sent_at, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, source_id) DO UPDATE SET
    content = excluded.content,
    metadata = excluded.metadata,
    updated_at = unixepoch()
`;

/** The imap source updates every column on conflict, but a stub (metadata.stub) never replaces a full message. */
export const UPSERT_MESSAGE_IMAP = `
  INSERT INTO messages (source, source_id, channel_id, channel_name, thread_id, author_id, author_name, content, sent_at, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, source_id) DO UPDATE SET
    channel_id = excluded.channel_id,
    channel_name = excluded.channel_name,
    thread_id = excluded.thread_id,
    author_id = excluded.author_id,
    author_name = excluded.author_name,
    content = excluded.content,
    sent_at = excluded.sent_at,
    metadata = excluded.metadata,
    updated_at = unixepoch()
  WHERE json_extract(excluded.metadata, '$.stub') IS NULL
     OR json_extract(messages.metadata, '$.stub') IS NOT NULL
`;

export const GET_IMAP_STUBS = `
  SELECT source_id, metadata FROM messages
  WHERE source = 'imap' AND json_extract(metadata, '$.stub') = 1
    AND json_extract(metadata, '$.account') = ? AND json_extract(metadata, '$.folder') = ?
    AND json_extract(metadata, '$.uidValidity') = ?
  ORDER BY sent_at DESC
  LIMIT ?
`;

export const MARK_IMAP_STUB_GONE = `
  UPDATE messages SET metadata = json_set(metadata, '$.stub', 'gone'), updated_at = unixepoch()
  WHERE source = 'imap' AND source_id = ? AND json_extract(metadata, '$.stub') = 1
`;

export const UPSERT_CONTACT = `
  INSERT INTO contacts (display_name)
  VALUES (?)
  ON CONFLICT(display_name) DO UPDATE SET
    updated_at = unixepoch()
  RETURNING id
`;

export const UPSERT_CONTACT_IDENTITY = `
  INSERT INTO contact_identities (contact_id, source, source_user_id, username, display_name)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(source, source_user_id) DO UPDATE SET
    username = excluded.username,
    display_name = excluded.display_name
`;

export const GET_CONTACT_BY_SOURCE_ID = `
  SELECT c.id, c.display_name
  FROM contacts c
  JOIN contact_identities ci ON ci.contact_id = c.id
  WHERE ci.source = ? AND ci.source_user_id = ?
`;

export const GET_SYNC_CURSOR = `
  SELECT cursor_value FROM sync_cursors WHERE source = ? AND key = ?
`;

export const SET_SYNC_CURSOR = `
  INSERT INTO sync_cursors (source, key, cursor_value)
  VALUES (?, ?, ?)
  ON CONFLICT(source, key) DO UPDATE SET
    cursor_value = excluded.cursor_value,
    updated_at = unixepoch()
`;

export const SEARCH_MESSAGES = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         bm25(messages_fts) AS rank
  FROM messages_fts
  JOIN messages m ON messages_fts.rowid = m.id
  WHERE messages_fts MATCH ?
  ORDER BY rank
`;

export const SEARCH_MESSAGES_FILTERED = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         bm25(messages_fts) AS rank
  FROM messages_fts
  JOIN messages m ON messages_fts.rowid = m.id
  WHERE messages_fts MATCH ?
`;

export const SEARCH_MESSAGES_FR_FILTERED = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         bm25(messages_fr_fts) AS rank
  FROM messages_fr_fts
  JOIN messages m ON messages_fr_fts.rowid = m.id
  WHERE messages_fr_fts MATCH ?
`;

export const UPSERT_MESSAGE_FR = `
  INSERT INTO messages_fr (message_id, stems)
  VALUES (?, ?)
  ON CONFLICT(message_id) DO UPDATE SET stems = excluded.stems
  WHERE stems != excluded.stems
`;

export const GET_MESSAGES_WITHOUT_FR = `
  SELECT m.id, m.content FROM messages m
  WHERE m.id NOT IN (SELECT message_id FROM messages_fr)
  ORDER BY m.id
  LIMIT ?
`;

export const GET_STATS = `
  SELECT
    (SELECT COUNT(*) FROM messages) AS total_messages,
    (SELECT COUNT(DISTINCT channel_name) FROM messages) AS total_channels,
    (SELECT COUNT(*) FROM contacts) AS total_contacts
`;

export const GET_MESSAGES = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata
  FROM messages m
  WHERE 1=1
`;

export const HAS_MESSAGE = `
  SELECT 1 FROM messages WHERE source = ? AND source_id = ? LIMIT 1
`;

export const INSERT_EMBEDDING = `
  INSERT INTO vec_messages(message_id, embedding)
  VALUES (?, ?)
`;

export const GET_UNEMBEDDED_MESSAGES = `
  SELECT m.id, m.content
  FROM messages m
  WHERE m.content != ''
    AND m.id NOT IN (SELECT message_id FROM vec_messages)
    AND m.id NOT IN (SELECT DISTINCT message_id FROM chunks)
  ORDER BY m.id DESC
  LIMIT ?
`;

export const VECTOR_SEARCH = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         v.distance
  FROM vec_messages v
  JOIN messages m ON m.id = v.message_id
  WHERE v.embedding MATCH ? AND k = ?
`;

export const EMBEDDING_STATS = `
  SELECT
    (SELECT COUNT(*) FROM messages WHERE id NOT IN (SELECT DISTINCT message_id FROM chunks)) AS total_messages,
    (SELECT COUNT(*) FROM vec_messages) AS embedded_messages
`;

export const DELETE_ORPHANED_EMBEDDINGS = `
  DELETE FROM vec_messages
  WHERE message_id NOT IN (SELECT id FROM messages)
     OR message_id IN (SELECT DISTINCT message_id FROM chunks)
`;

// Chunk queries
export const REPLACE_CHUNKS_DELETE = `
  DELETE FROM chunks WHERE message_id = ?
`;

export const INSERT_CHUNK = `
  INSERT INTO chunks (message_id, chunk_index, content, embedding_input)
  VALUES (?, ?, ?, ?)
`;

export const GET_UNEMBEDDED_CHUNKS = `
  SELECT c.id, c.embedding_input AS content
  FROM chunks c
  WHERE c.content != ''
    AND c.id NOT IN (SELECT chunk_id FROM vec_chunks)
  ORDER BY c.id DESC
  LIMIT ?
`;

export const INSERT_CHUNK_EMBEDDING = `
  INSERT INTO vec_chunks(chunk_id, embedding)
  VALUES (?, ?)
`;

export const DELETE_ORPHANED_CHUNK_EMBEDDINGS = `
  DELETE FROM vec_chunks
  WHERE chunk_id NOT IN (SELECT id FROM chunks)
`;

export const DELETE_ORPHANED_CHUNKS = `
  DELETE FROM chunks
  WHERE message_id NOT IN (SELECT id FROM messages)
`;

export const SEARCH_CHUNKS_FILTERED = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, c.content, m.sent_at, m.metadata,
         bm25(chunks_fts) AS rank
  FROM chunks_fts
  JOIN chunks c ON chunks_fts.rowid = c.id
  JOIN messages m ON m.id = c.message_id
  WHERE chunks_fts MATCH ?
`;

export const VECTOR_SEARCH_CHUNKS = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, c.content, m.sent_at, m.metadata,
         v.distance
  FROM vec_chunks v
  JOIN chunks c ON c.id = v.chunk_id
  JOIN messages m ON m.id = c.message_id
  WHERE v.embedding MATCH ? AND k = ?
`;

export const CHUNK_EMBEDDING_STATS = `
  SELECT
    (SELECT COUNT(*) FROM chunks) AS total_chunks,
    (SELECT COUNT(*) FROM vec_chunks) AS embedded_chunks
`;

export const GET_MESSAGE_CHUNK_IDS = `
  SELECT id FROM chunks WHERE message_id = ?
`;

// FTS backfill: search only messages that have NOT been embedded yet
export const FTS_BACKFILL_MESSAGES = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         bm25(messages_fts) AS rank
  FROM messages_fts
  JOIN messages m ON messages_fts.rowid = m.id
  WHERE messages_fts MATCH ?
    AND m.id NOT IN (SELECT message_id FROM vec_messages)
    AND m.id NOT IN (SELECT DISTINCT message_id FROM chunks)
`;

// French FTS backfill: the same messages, through their French stems
export const FTS_BACKFILL_MESSAGES_FR = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         bm25(messages_fr_fts) AS rank
  FROM messages_fr_fts
  JOIN messages m ON messages_fr_fts.rowid = m.id
  WHERE messages_fr_fts MATCH ?
    AND m.id NOT IN (SELECT message_id FROM vec_messages)
    AND m.id NOT IN (SELECT DISTINCT message_id FROM chunks)
`;

// FTS backfill: search only chunks that have NOT been embedded yet
export const FTS_BACKFILL_CHUNKS = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, c.content, m.sent_at, m.metadata,
         bm25(chunks_fts) AS rank
  FROM chunks_fts
  JOIN chunks c ON chunks_fts.rowid = c.id
  JOIN messages m ON m.id = c.message_id
  WHERE chunks_fts MATCH ?
    AND c.id NOT IN (SELECT chunk_id FROM vec_chunks)
`;

export const LIKE_SEARCH_MESSAGES = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata
  FROM messages m
  WHERE m.content LIKE '%' || ? || '%'
`;

export const LIKE_SEARCH_CHUNKS = `
  SELECT m.id, m.source, m.source_id, m.channel_name, m.thread_id,
         m.author_name, c.content, m.sent_at, m.metadata
  FROM chunks c
  JOIN messages m ON m.id = c.message_id
  WHERE c.content LIKE '%' || ? || '%'
`;

export const GET_UNCHUNKED_LONG_MESSAGES = `
  SELECT m.id, m.content
  FROM messages m
  WHERE length(m.content) > ?
    AND m.id IN (SELECT message_id FROM vec_messages)
    AND m.id NOT IN (SELECT DISTINCT message_id FROM chunks)
  ORDER BY m.id DESC
  LIMIT ?
`;

export const GET_THREAD = `
  SELECT m.source, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata
  FROM messages m
  WHERE m.thread_id = ?
  ORDER BY m.sent_at ASC
`;

export const GET_THREADS_BY_DATE = `
  SELECT m.source, m.channel_name, m.thread_id,
         m.author_name, m.content, m.sent_at, m.metadata,
         COUNT(*) OVER (PARTITION BY m.thread_id) AS thread_size
  FROM messages m
  WHERE m.thread_id IS NOT NULL
    AND m.sent_at >= ? AND m.sent_at < ?
  ORDER BY m.sent_at ASC
`;

export const GET_CHANNELS = `
  SELECT source, channel_name,
         COUNT(*) AS msg_count,
         MAX(sent_at) AS last_message
  FROM messages
  WHERE 1=1
  GROUP BY source, channel_name
  ORDER BY last_message DESC
`;

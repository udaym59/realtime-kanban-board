-- Init migration — matches what `prisma migrate dev --name init` would emit for
-- the current schema.prisma, with CHECK constraints hand-added at the end to
-- enforce schema-level invariants (see tasks/plan.md P0 and the audit).
--
-- Review via `backend-design:review-migration` BEFORE `prisma migrate deploy`.

-- CreateTable
CREATE TABLE "boards" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "columns" (
    "id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cards" (
    "id" UUID NOT NULL,
    "column_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "position" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (also serves as uniqueness constraint — one card per rank per column)
CREATE UNIQUE INDEX "columns_board_id_position_key" ON "columns"("board_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "cards_column_id_position_key" ON "cards"("column_id", "position");

-- CreateIndex (serves "newest card in column" + any created_at sort)
CREATE INDEX "cards_column_id_created_at_idx" ON "cards"("column_id", "created_at");

-- AddForeignKey (cascade both — board delete removes its columns and cards)
ALTER TABLE "columns"
  ADD CONSTRAINT "columns_board_id_fkey"
  FOREIGN KEY ("board_id") REFERENCES "boards"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards"
  ADD CONSTRAINT "cards_column_id_fkey"
  FOREIGN KEY ("column_id") REFERENCES "columns"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-added CHECK constraints (schema invariants from backend-design audit)
-- ---------------------------------------------------------------------------
-- These are NOT expressible in Prisma schema (as of 5.22). Keeping them in-DB
-- means a direct psql write, a Studio edit, or a buggy service cannot leave
-- the table in an invalid state.
--
-- version:  optimistic-lock counter never goes negative
-- position: fractional-index key must be non-empty (fractional-indexing never
--           emits "", but defense in depth)
-- title/name: non-empty when trimmed (Zod enforces at boundary too)

ALTER TABLE "cards"
  ADD CONSTRAINT "cards_version_non_negative" CHECK ("version" >= 0);

ALTER TABLE "cards"
  ADD CONSTRAINT "cards_position_non_empty" CHECK (length("position") > 0);

ALTER TABLE "cards"
  ADD CONSTRAINT "cards_title_non_empty" CHECK (length(trim("title")) > 0);

ALTER TABLE "columns"
  ADD CONSTRAINT "columns_position_non_empty" CHECK (length("position") > 0);

ALTER TABLE "columns"
  ADD CONSTRAINT "columns_name_non_empty" CHECK (length(trim("name")) > 0);

ALTER TABLE "boards"
  ADD CONSTRAINT "boards_name_non_empty" CHECK (length(trim("name")) > 0);

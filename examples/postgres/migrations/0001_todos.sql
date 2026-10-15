CREATE TABLE todos (
  id serial PRIMARY KEY,
  title text NOT NULL UNIQUE,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX todos_done ON todos (done);

import { describe, expect, test } from "bun:test";
import { migrate, splitSql, sqlite } from "../src/index.ts";

describe("splitSql: basics", () => {
  test("splits on semicolons and trims", () => {
    expect(splitSql("SELECT 1; SELECT 2;\n  SELECT 3")).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  test("drops empty statements", () => {
    expect(splitSql(";;  ;\n;SELECT 1;;")).toEqual(["SELECT 1"]);
    expect(splitSql("")).toEqual([]);
    expect(splitSql("   \n\t ")).toEqual([]);
  });
});

describe("splitSql: quotes", () => {
  test("semicolons in single-quoted strings", () => {
    expect(splitSql("INSERT INTO t VALUES ('a;b'); SELECT 1")).toEqual(["INSERT INTO t VALUES ('a;b')", "SELECT 1"]);
  });

  test("doubled single quotes stay inside the string", () => {
    expect(splitSql("SELECT 'it''s; fine'; SELECT 2")).toEqual(["SELECT 'it''s; fine'", "SELECT 2"]);
  });

  test("double-quoted, backtick and bracket identifiers", () => {
    expect(splitSql('SELECT "a;b" FROM x; SELECT `c;d`; SELECT [e;f] FROM y')).toEqual([
      'SELECT "a;b" FROM x',
      "SELECT `c;d`",
      "SELECT [e;f] FROM y",
    ]);
  });

  test("comment markers inside strings are kept", () => {
    expect(splitSql("SELECT '--not a comment;'; SELECT '/* nor; this */'")).toEqual([
      "SELECT '--not a comment;'",
      "SELECT '/* nor; this */'",
    ]);
  });

  test("keywords inside strings do not open a trigger body", () => {
    expect(splitSql("SELECT 'CREATE TRIGGER x BEGIN'; SELECT 2")).toEqual(["SELECT 'CREATE TRIGGER x BEGIN'", "SELECT 2"]);
  });

  test("an unterminated string swallows the rest", () => {
    expect(splitSql("SELECT 1; SELECT 'oops; SELECT 2")).toEqual(["SELECT 1", "SELECT 'oops; SELECT 2"]);
  });
});

describe("splitSql: comments", () => {
  test("line comments are removed but keep the newline between tokens", () => {
    expect(splitSql("SELECT 1 -- one; two\nFROM t; SELECT 2")).toEqual(["SELECT 1 \nFROM t", "SELECT 2"]);
  });

  test("block comments are removed, including multi-line ones with semicolons", () => {
    expect(splitSql("SELECT /* a; b\n c; */ 1; /* only a comment; */ SELECT 2")).toEqual(["SELECT   1", "SELECT 2"]);
  });

  test("a block comment glued between tokens still separates them", () => {
    expect(splitSql("SELECT/**/1")).toEqual(["SELECT 1"]);
  });

  test("comment-only input yields nothing", () => {
    expect(splitSql("-- just a note;\n/* and; another */")).toEqual([]);
  });

  test("an unterminated block comment swallows the rest", () => {
    expect(splitSql("SELECT 1; /* never closed; SELECT 2")).toEqual(["SELECT 1"]);
  });

  test("a line comment at the end without a newline", () => {
    expect(splitSql("SELECT 1; -- trailing")).toEqual(["SELECT 1"]);
  });
});

describe("splitSql: SQLite without dollar quoting", () => {
  test("$ is an ordinary character (named parameters, no $$ bodies)", () => {
    expect(splitSql("SELECT $a, $$; SELECT 2")).toEqual(["SELECT $a, $$", "SELECT 2"]);
  });
});

describe("splitSql: triggers", () => {
  const trigger = "CREATE TRIGGER log_ins AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.id); UPDATE c SET n = n + 1; END";

  test("keeps a BEGIN ... END trigger body together", () => {
    expect(splitSql(`CREATE TABLE t (id INTEGER);\n${trigger};\nSELECT 1;`)).toEqual(["CREATE TABLE t (id INTEGER)", trigger, "SELECT 1"]);
  });

  test("a trigger as the last statement without a trailing semicolon", () => {
    expect(splitSql(`SELECT 1; ${trigger}`)).toEqual(["SELECT 1", trigger]);
  });

  test("TEMP / TEMPORARY / IF NOT EXISTS triggers and any keyword case", () => {
    for (const head of ["create temp trigger", "CREATE TEMPORARY TRIGGER", "Create Trigger If Not Exists"]) {
      const sql = `${head} x before delete on t begin select raise(abort, 'no; way'); delete from y; end`;
      expect(splitSql(`${sql}; SELECT 2`)).toEqual([sql, "SELECT 2"]);
    }
  });

  test("CASE ... END inside a trigger body does not close the body", () => {
    const sql =
      "CREATE TRIGGER c AFTER UPDATE ON t BEGIN UPDATE t SET v = CASE WHEN new.v > 0 THEN 1 ELSE CASE WHEN new.v < 0 THEN -1 END END; INSERT INTO log VALUES (1); END";
    expect(splitSql(`${sql}; SELECT 3`)).toEqual([sql, "SELECT 3"]);
  });

  test("CASE ... END in a WHEN clause before BEGIN", () => {
    const sql = "CREATE TRIGGER w AFTER INSERT ON t WHEN CASE new.v WHEN 1 THEN 1 END BEGIN DELETE FROM a; DELETE FROM b; END";
    expect(splitSql(`${sql};SELECT 4`)).toEqual([sql, "SELECT 4"]);
  });

  test("END inside strings, quoted identifiers and comments in a trigger body is ignored", () => {
    const sql = `CREATE TRIGGER q AFTER INSERT ON t BEGIN INSERT INTO log ("end") VALUES ('END;'); /* END; */ DELETE FROM z; END`;
    expect(splitSql(`${sql}; SELECT 5`)).toEqual([
      `CREATE TRIGGER q AFTER INSERT ON t BEGIN INSERT INTO log ("end") VALUES ('END;');   DELETE FROM z; END`,
      "SELECT 5",
    ]);
  });

  test("words that merely contain BEGIN/END/CASE are not keywords", () => {
    const sql = "CREATE TRIGGER k AFTER INSERT ON t BEGIN UPDATE t SET ending = 1, cases = 2, begins = 3; DELETE FROM w; END";
    expect(splitSql(`${sql}; SELECT 6`)).toEqual([sql, "SELECT 6"]);
  });

  test("BEGIN / END transactions outside triggers still split", () => {
    expect(splitSql("BEGIN; INSERT INTO t VALUES (1); END; BEGIN TRANSACTION; COMMIT")).toEqual([
      "BEGIN",
      "INSERT INTO t VALUES (1)",
      "END",
      "BEGIN TRANSACTION",
      "COMMIT",
    ]);
  });

  test("CASE ... END in an ordinary statement", () => {
    expect(splitSql("SELECT CASE WHEN 1 THEN 'a;' END AS x; SELECT 2")).toEqual(["SELECT CASE WHEN 1 THEN 'a;' END AS x", "SELECT 2"]);
  });

  test("two triggers back to back", () => {
    const a = "CREATE TRIGGER a AFTER INSERT ON t BEGIN DELETE FROM x; END";
    const b = "CREATE TRIGGER b AFTER DELETE ON t BEGIN DELETE FROM y; DELETE FROM z; END";
    expect(splitSql(`${a};\n${b};`)).toEqual([a, b]);
  });
});

describe("splitSql with a real database", () => {
  test("migrate() can create a trigger with a multi-statement body", async () => {
    const database = sqlite();
    await migrate(database, [
      {
        id: "0001_audit",
        sql: `
          CREATE TABLE items (id INTEGER PRIMARY KEY, v INTEGER);
          CREATE TABLE log (msg TEXT); -- audit trail; append only
          /* Count and label every insert; keep it simple. */
          CREATE TRIGGER items_ins AFTER INSERT ON items BEGIN
            INSERT INTO log (msg) VALUES ('ins;' || CASE WHEN new.v > 0 THEN 'pos' ELSE 'neg' END);
            INSERT INTO log (msg) VALUES ('done');
          END;
          CREATE TRIGGER items_no_update BEFORE UPDATE ON items BEGIN SELECT RAISE(ABORT, 'append-only; sorry'); END;
        `,
      },
    ]);
    await database.prepare("INSERT INTO items (v) VALUES (?)").bind(5).run();
    const { results } = await database.prepare("SELECT msg FROM log ORDER BY rowid").all<{ msg: string }>();
    expect(results.map((r) => r.msg)).toEqual(["ins;pos", "done"]);
    await expect(database.prepare("UPDATE items SET v = 1").run()).rejects.toThrow("append-only; sorry");
  });

  test("exec() runs a trigger script", async () => {
    const database = sqlite();
    const r = await database.exec(
      "CREATE TABLE a (x INTEGER); CREATE TABLE b (y INTEGER); CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (new.x); INSERT INTO b VALUES (new.x * 2); END;",
    );
    expect(r.count).toBe(3);
    await database.prepare("INSERT INTO a VALUES (?)").bind(2).run();
    const { results } = await database.prepare("SELECT y FROM b ORDER BY y").all<{ y: number }>();
    expect(results.map((r) => r.y)).toEqual([2, 4]);
  });
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_turns ADD COLUMN input_tokens INTEGER`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN output_tokens INTEGER`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN cache_read_tokens INTEGER`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN cache_write_tokens INTEGER`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN total_cost_usd REAL`;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN model TEXT`;
});

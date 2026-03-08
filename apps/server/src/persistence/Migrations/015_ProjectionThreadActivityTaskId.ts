import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN task_id TEXT
  `;

  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN parent_tool_use_id TEXT
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_task_id
    ON projection_thread_activities(task_id)
  `;
});

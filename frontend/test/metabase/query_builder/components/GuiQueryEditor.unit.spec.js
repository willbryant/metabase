import React from "react";
import { render, screen } from "@testing-library/react";

import GuiQueryEditor from "metabase/query_builder/components/GuiQueryEditor";
import {
  SAMPLE_DATABASE,
  ORDERS,
  metadata,
} from "__support__/sample_database_fixture";
import Question from "metabase-lib/lib/Question";

const getGuiQueryEditor = query => (
  <GuiQueryEditor
    query={query}
    databases={metadata.databasesList()}
    tables={metadata.tablesList()}
    setDatabaseFn={() => {}}
    setSourceTableFn={() => {}}
    setDatasetQuery={() => {}}
    isShowingDataReference={false}
  />
);

describe("GuiQueryEditor", () => {
  it("should allow adding the first breakout", () => {
    const query = Question.create({
      databaseId: SAMPLE_DATABASE.id,
      tableId: ORDERS.id,
      metadata,
    })
      .query()
      .aggregate(["count"]);

    render(getGuiQueryEditor(query));
    const ADD_ICONS = screen.getAllByRole("img", { name: /add/i });

    screen.getByText("Add a grouping");
    // 1. Filter, 2. Count, 3. Group-by
    expect(ADD_ICONS.length).toBe(3);
  });

  it("should allow adding more than one breakout", () => {
    const query = Question.create({
      databaseId: SAMPLE_DATABASE.id,
      tableId: ORDERS.id,
      metadata,
    })
      .query()
      .aggregate(["count"])
      .breakout(["field", ORDERS.TOTAL.id, null]);

    render(getGuiQueryEditor(query));
    const ADD_ICONS = screen.getAllByRole("img", { name: /add/i });

    screen.getByText("Total");
    screen.getByRole("img", { name: /close/i }); // Now we can close the first breakout
    // 1. Filter, 2. Count, 3. Group-by (new add icon after the first breakout)
    expect(ADD_ICONS.length).toBe(3);
  });
});

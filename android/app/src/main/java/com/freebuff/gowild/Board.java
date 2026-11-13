package com.freebuff.gowild;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;

public final class Board {
    public final String origin;
    public final String originCity;
    public final int routeCount;
    public final int ageMinutes;
    public final boolean stale;
    public final boolean sample;
    public final String source;
    public final List<BoardDay> days;

    public Board(String origin, String originCity, int routeCount, int ageMinutes, boolean stale,
                 boolean sample, String source, List<BoardDay> days) {
        this.origin = origin;
        this.originCity = originCity;
        this.routeCount = routeCount;
        this.ageMinutes = ageMinutes;
        this.stale = stale;
        this.sample = sample;
        this.source = source;
        this.days = days;
    }

    /**
     * The snapshot is bundled rather than fetched: the app has no deployed origin yet,
     * and five designs should be judged on design. tools/android-fixture.mjs builds it
     * from a real collector capture, rebased forward.
     */
    public static Board load(Context ctx) {
        try {
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(ctx.getAssets().open("board.json"), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            JSONObject o = new JSONObject(sb.toString());
            List<BoardDay> days = new ArrayList<>();
            JSONArray arr = o.getJSONArray("days");
            for (int i = 0; i < arr.length(); i++) {
                JSONObject d = arr.getJSONObject(i);
                List<FareRow> rows = new ArrayList<>();
                JSONArray ra = d.getJSONArray("rows");
                for (int j = 0; j < ra.length(); j++) {
                    JSONObject r = ra.getJSONObject(j);
                    rows.add(new FareRow(
                            r.getString("dep"),
                            r.getString("clock"),
                            r.getString("clock12"),
                            r.getString("dest"),
                            r.getString("city"),
                            r.optString("stops", ""),
                            r.optString("dur", ""),
                            r.isNull("seats") ? null : Integer.valueOf(r.getInt("seats")),
                            r.getDouble("allin"),
                            r.isNull("leaveBy") ? null : r.getString("leaveBy"),
                            r.optBoolean("tight", false)));
                }
                days.add(new BoardDay(
                        d.getString("date"),
                        d.getString("weekday"),
                        d.getString("dayNum"),
                        d.getString("month"),
                        d.getString("label"),
                        d.optInt("options", rows.size()),
                        d.isNull("from") ? null : Double.valueOf(d.getDouble("from")),
                        rows));
            }
            return new Board(
                    o.optString("origin", "RDU"),
                    o.optString("originCity", ""),
                    o.optInt("routeCount", 0),
                    o.optInt("ageMinutes", 0),
                    o.optBoolean("stale", false),
                    o.optBoolean("sample", true),
                    o.optString("source", ""),
                    days);
        } catch (Exception e) {
            // A missing asset must not be a blank screen: the header and footer still
            // render, and the empty day list is visible as an empty board.
            return new Board("RDU", "", 0, 0, false, true, "asset error: " + e.getClass().getSimpleName(),
                    new ArrayList<BoardDay>());
        }
    }
}

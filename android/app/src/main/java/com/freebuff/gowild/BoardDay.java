package com.freebuff.gowild;

import java.util.List;

public final class BoardDay {
    public final String date;
    public final String weekday;
    public final String dayNum;
    public final String month;
    public final String label;
    public final int options;
    public final Double from;
    public final List<FareRow> rows;

    public BoardDay(String date, String weekday, String dayNum, String month, String label,
                    int options, Double from, List<FareRow> rows) {
        this.date = date;
        this.weekday = weekday;
        this.dayNum = dayNum;
        this.month = month;
        this.label = label;
        this.options = options;
        this.from = from;
        this.rows = rows;
    }
}

package com.freebuff.gowild.designs;

import android.graphics.Canvas;
import android.graphics.Paint;

import com.freebuff.gowild.BaseDesign;
import com.freebuff.gowild.Board;
import com.freebuff.gowild.BoardDay;
import com.freebuff.gowild.FareRow;
import com.freebuff.gowild.Fmt;
import com.freebuff.gowild.Insets;
import com.freebuff.gowild.Type;

/**
 * 03 GRID - a Swiss railway timetable. No cards and no shadows: a strict column
 * arithmetic with full-bleed hairlines, one signal red, and the date as an index
 * number in the margin. The quietest of the five, and the fastest to read.
 */
public class Grid extends BaseDesign {
    private static final int BG = 0xFFF6F4ED;
    private static final int INK = 0xFF0B0B0A;
    private static final int RED = 0xFFC5321B;
    private static final int GREY = 0xFF89857A;
    private static final int SOFT = 0xFFD9D4C5;

    public Grid(Board b, float d) {
        super(b, d);
    }

    @Override
    public int id() {
        return 3;
    }

    @Override
    public String name() {
        return "GRID";
    }

    @Override
    public float draw(Canvas c, int w, int h, float scroll, Insets insets) {
        c.drawColor(BG);
        float m = px(18f);
        float y = insets.top + px(24f) - scroll;

        // ---- masthead -------------------------------------------------------
        text(c, b.origin, m, y + px(28f), paint(30f, Type.black, INK));
        tracked(c, "GOWILD / 48 H", m, y + px(44f), paint(7.5f, Type.mono, GREY), px(2.6f), false);
        text(c, b.ageMinutes + " MIN", w - m, y + px(22f), paint(13f, Type.monoBold, INK), Paint.Align.RIGHT);
        tracked(c, b.stale ? "STALE" : (b.sample ? "SAMPLE" : "LIVE"), w - m, y + px(34f),
                paint(7f, Type.mono, GREY), px(2f), true);
        y += px(52f);
        hline(c, 0f, w, y, INK, px(3f));
        y += px(24f);

        int section = 0;
        for (BoardDay day : b.days) {
            // A running section index, not the day number: "12 THU 12 NOV" says 12 twice.
            section++;
            String idxTxt = (section < 10 ? "0" : "") + section;
            tracked(c, idxTxt, m, y, paint(9f, Type.mono, GREY), px(1.2f), false);
            text(c, day.weekday.toUpperCase() + " " + day.dayNum + " " + day.month, m + px(24f), y, paint(15f, Type.condBold, INK));
            String fromTxt = day.from == null ? "\u2014" : Fmt.full(day.from);
            text(c, fromTxt, w - m, y, paint(9f, Type.monoBold, INK), Paint.Align.RIGHT);
            float fromW = paint(9f, Type.monoBold, INK).measureText(fromTxt);
            text(c, day.options + " OPTIONS", w - m - fromW - px(12f), y, paint(7.5f, Type.mono, GREY), Paint.Align.RIGHT);
            y += px(8f);
            hline(c, m, w - m, y, INK, px(1f));
            y += px(6f);

            for (FareRow r : day.rows) {
                float rowH = px(56f);
                if (r.tight) rect(c, 0f, y, px(3f), rowH, RED);

                // column 1: the clock. Column 2: the city. Column 3: the money.
                // 12-hour here, not 24: the column carries its own meridiem underneath,
                // and "06:30" over "AM" is the same fact said twice in two systems.
                text(c, r.clock12.substring(0, r.clock12.indexOf(' ')), m, y + px(23f), paint(12f, Type.monoBold, INK));
                text(c, r.clock12.substring(r.clock12.indexOf(' ') + 1), m, y + px(35f), paint(7f, Type.mono, GREY));

                float tx = m + px(62f);
                text(c, r.city, tx, y + px(24f), fittedPaint(r.city, w - m - px(96f) - tx, 16f, Type.condBold, INK));
                float metaW = tracked(c, r.dest + " \u00B7 " + r.dur + " \u00B7 " + r.stops, tx, y + px(38f),
                        paint(7f, Type.mono, GREY), px(0.9f), false);
                String seatTxt = Fmt.seats(r.seats);
                if (!seatTxt.isEmpty()) {
                    tracked(c, " \u00B7 " + seatTxt, tx + metaW, y + px(38f),
                            paint(7f, Type.mono, (r.seats != null && r.seats <= 2) ? RED : GREY), px(0.9f), false);
                }

                // The cents are set smaller, so the whole number is placed to their left.
                String fracTxt = Fmt.frac(r.allin);
                Paint fracPaint = paint(10f, Type.mono, INK);
                float fracW = fracPaint.measureText(fracTxt);
                text(c, Fmt.whole(r.allin), w - m - fracW, y + px(24f), paint(15f, Type.monoBold, INK), Paint.Align.RIGHT);
                text(c, fracTxt, w - m, y + px(24f), fracPaint, Paint.Align.RIGHT);
                tracked(c, "EST ALL-IN", w - m, y + px(37f), paint(6f, Type.mono, GREY), px(1.4f), true);

                y += rowH;
                hline(c, 0f, w, y, SOFT, px(1f));
            }
            y += px(22f);
        }

        // ---- footer ---------------------------------------------------------
        hline(c, 0f, w, y, INK, px(3f));
        y += px(18f);
        tracked(c, "ESTIMATED ALL-IN \u00B7 FRONTIER GOWILD", m, y, paint(7f, Type.mono, GREY), px(2f), false);
        y += px(11f);
        tracked(c, "READ-ONLY \u00B7 NO BOOKING PATH", m, y, paint(7f, Type.mono, GREY), px(2f), false);
        y += px(11f);
        tracked(c, "LIGHT MODE \u00B7 FOLLOWS SYSTEM THEME", m, y, paint(7f, Type.mono, alpha(GREY, 170)), px(1.8f), false);
        y += insets.bottom + px(22f);
        return y + scroll;
    }
}

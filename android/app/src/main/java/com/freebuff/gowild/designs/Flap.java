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
 * 01 FLAP - an airport split-flap board. Departure times are physical cells with a
 * crease, the city is condensed caps, the fare is an amber read-out. Nothing is a
 * card: every row is a strip on one continuous surface.
 */
public class Flap extends BaseDesign {
    private static final int BG = 0xFF0B0B0A;
    private static final int BONE = 0xFFF1EFE7;
    private static final int AMBER = 0xFFF0A63C;
    private static final int DIM = 0xFF6E6B62;
    private static final int RULE = 0xFF232019;
    private static final int CELL_BG = 0xFF17160F;
    private static final int CELL_TOP = 0xFF201E14;
    private static final int BAD = 0xFFFF5C3D;

    public Flap(Board b, float d) {
        super(b, d);
    }

    @Override
    public int id() {
        return 1;
    }

    @Override
    public String name() {
        return "FLAP";
    }

    @Override
    public float draw(Canvas c, int w, int h, float scroll, Insets insets) {
        c.drawColor(BG);
        float m = px(20f);
        float y = insets.top + px(18f) - scroll;

        // ---- masthead -------------------------------------------------------
        c.drawText(b.origin, m, y + px(34f), paint(44f, Type.monoBold, BONE));
        tracked(c, "FRONTIER GOWILD", m, y + px(50f), paint(9f, Type.mono, DIM), px(3.4f), false);
        text(c, String.valueOf(b.routeCount), w - m, y + px(20f), paint(19f, Type.monoBold, AMBER), Paint.Align.RIGHT);
        tracked(c, "ROUTES", w - m, y + px(32f), paint(7.5f, Type.mono, DIM), px(2.4f), true);
        y += px(60f);
        hline(c, m, w - m, y, RULE, px(1f));
        y += px(16f);

        String fresh = b.stale ? "STALE SNAPSHOT" : "UPDATED " + b.ageMinutes + " MIN AGO";
        text(c, fresh, m, y, paint(8.5f, Type.mono, b.stale ? BAD : DIM));
        tracked(c, b.sample ? "SAMPLE" : "LIVE", w - m, y, paint(8.5f, Type.mono, DIM), px(2f), true);
        y += px(18f);

        // ---- days -----------------------------------------------------------
        for (BoardDay day : b.days) {
            y += px(10f);
            tracked(c, day.label, m, y, paint(10f, Type.monoBold, AMBER), px(4f), false);
            String right = day.options + " OPTIONS" + (day.from == null ? "" : " \u00B7 FROM " + Fmt.full(day.from));
            tracked(c, right, w - m, y, paint(7.5f, Type.mono, DIM), px(1.6f), true);
            y += px(10f);
            hline(c, m, w - m, y, RULE, px(1f));
            y += px(4f);

            for (FareRow r : day.rows) {
                float top = y;
                float rowH = px(84f);

                // split-flap clock: 5 cells, the colon narrow
                float cellW = px(19f);
                float cellH = px(29f);
                float gap = px(2f);
                float cx = m;
                Paint digit = paint(16f, Type.monoBold, BONE);
                for (int i = 0; i < r.clock.length(); i++) {
                    char ch = r.clock.charAt(i);
                    float cw = ch == ':' ? px(9f) : cellW;
                    rect(c, cx, top + px(9f), cw, cellH, CELL_BG);
                    c.drawRect(cx, top + px(9f), cx + cw, top + px(9f) + px(6f), fill(CELL_TOP));
                    hline(c, cx, cx + cw, top + px(9f) + cellH * 0.55f, BG, px(1f));
                    text(c, String.valueOf(ch), cx + cw / 2f, top + px(9f) + cellH * 0.72f,
                            ch == ':' ? paint(13f, Type.mono, DIM) : digit, Paint.Align.CENTER);
                    cx += cw + gap;
                }

                // city block
                float tx = cx + px(12f);
                text(c, r.city, tx, top + px(30f), fittedPaint(r.city, w - m - px(82f) - tx, 17f, Type.condBold, BONE));
                tracked(c, r.dest + " \u00B7 " + r.dur + " \u00B7 " + r.stops, tx, top + px(46f),
                        paint(8f, Type.mono, DIM), px(1.1f), false);

                // Seats and the leave-by time get their own line: on one line the
                // seat label ran under the fare's caption.
                int seatColor;
                if (r.seats == null) seatColor = DIM;
                else if (r.seats <= 0) seatColor = BAD;
                else if (r.seats <= 2) seatColor = AMBER;
                else seatColor = DIM;
                String seats = Fmt.seats(r.seats);
                float seatW = 0f;
                if (!seats.isEmpty()) {
                    seatW = tracked(c, seats, tx, top + px(62f), paint(7.5f, Type.monoBold, seatColor), px(1.2f), false);
                }
                if (r.leaveBy != null) {
                    tracked(c, (seatW > 0f ? " \u00B7 " : "") + "LEAVE BY " + r.leaveBy, tx + seatW, top + px(62f),
                            paint(7.5f, Type.mono, DIM), px(1.2f), false);
                }

                // Fare: the cents are smaller, so the fraction is measured first and the
                // whole number is placed to its left. Drawing both right-aligned at the
                // same x paints them on top of each other.
                String fracTxt = Fmt.frac(r.allin);
                Paint fracPaint = paint(12f, Type.mono, AMBER);
                float fracW = fracPaint.measureText(fracTxt);
                text(c, Fmt.whole(r.allin), w - m - fracW, top + px(32f), paint(20f, Type.monoBold, AMBER), Paint.Align.RIGHT);
                text(c, fracTxt, w - m, top + px(32f), fracPaint, Paint.Align.RIGHT);
                tracked(c, "EST ALL-IN", w - m, top + px(46f), paint(7f, Type.mono, DIM), px(1.6f), true);

                y += rowH;
                hline(c, m, w - m, y, RULE, px(1f));
            }
            y += px(18f);
        }

        // ---- footer ---------------------------------------------------------
        y += px(10f);
        hline(c, m, w - m, y, RULE, px(1f));
        y += px(16f);
        tracked(c, "ESTIMATED ALL-IN \u00B7 READ-ONLY", m, y, paint(7.5f, Type.mono, DIM), px(2.2f), false);
        y += px(12f);
        tracked(c, "DARK MODE \u00B7 FOLLOWS SYSTEM THEME", m, y, paint(7.5f, Type.mono, alpha(DIM, 120)), px(1.8f), false);
        y += insets.bottom + px(22f);
        return y + scroll;
    }
}

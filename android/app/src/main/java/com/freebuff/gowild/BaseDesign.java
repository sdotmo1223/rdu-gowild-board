package com.freebuff.gowild;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;

/** Shared drawing primitives. Everything the five designs use is here, which is what
 *  keeps them looking like five systems rather than five copies of one shader. */
public abstract class BaseDesign implements Design {
    protected final Board b;
    protected final float d;

    protected BaseDesign(Board b, float d) {
        this.b = b;
        this.d = d;
    }

    protected float px(float v) {
        return v * d;
    }

    protected Paint paint(float sizeSp, Typeface tf, int color) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setTextSize(sizeSp * d);
        p.setTypeface(tf);
        p.setColor(color);
        p.setSubpixelText(true);
        return p;
    }

    /** A city name that overflows into the fare column is a design failure, not a data
     *  problem. Shrink to fit rather than clip. */
    protected Paint fittedPaint(String s, float maxWidth, float sizeSp, Typeface tf, int color) {
        Paint p = paint(sizeSp, tf, color);
        int guard = 0;
        while (p.measureText(s) > maxWidth && p.getTextSize() > px(7f) && guard < 60) {
            p.setTextSize(p.getTextSize() * 0.955f);
            guard++;
        }
        return p;
    }

    protected Paint fill(int color) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(color);
        p.setStyle(Paint.Style.FILL);
        return p;
    }

    protected Paint stroke(int color, float width) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(color);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(width);
        return p;
    }

    /**
     * Canvas.drawText ignores letter spacing, so tracking is per glyph. This is also
     * what makes the split-flap cells and the wide-spaced labels exact instead of
     * approximately spaced.
     */
    protected float tracked(Canvas c, String s, float x, float y, Paint p, float tracking, boolean alignRight) {
        float width = 0f;
        for (int i = 0; i < s.length(); i++) {
            width += p.measureText(s.substring(i, i + 1)) + (i < s.length() - 1 ? tracking : 0f);
        }
        float cx = alignRight ? x - width : x;
        for (int i = 0; i < s.length(); i++) {
            String ch = s.substring(i, i + 1);
            c.drawText(ch, cx, y, p);
            cx += p.measureText(ch) + tracking;
        }
        return width;
    }

    protected void text(Canvas c, String s, float x, float y, Paint p) {
        text(c, s, x, y, p, Paint.Align.LEFT);
    }

    protected void text(Canvas c, String s, float x, float y, Paint p, Paint.Align align) {
        p.setTextAlign(align);
        c.drawText(s, x, y, p);
        p.setTextAlign(Paint.Align.LEFT);
    }

    protected void hline(Canvas c, float x1, float x2, float y, int color, float thickness) {
        c.drawLine(x1, y, x2, y, stroke(color, thickness));
    }

    protected void vline(Canvas c, float x, float y1, float y2, int color, float thickness) {
        c.drawLine(x, y1, x, y2, stroke(color, thickness));
    }

    protected void rect(Canvas c, float x, float y, float w, float h, int color) {
        c.drawRect(x, y, x + w, y + h, fill(color));
    }

    protected void dashedV(Canvas c, float x, float y1, float y2, int color, float dash, float gap) {
        Paint p = stroke(color, 1f);
        float y = y1;
        while (y < y2) {
            c.drawLine(x, y, x, Math.min(y + dash, y2), p);
            y += dash + gap;
        }
    }

    protected void dots(Canvas c, float x, float y, float w, float h, float step, float radius, int color) {
        Paint p = fill(color);
        float yy = y;
        while (yy < y + h) {
            float xx = x;
            while (xx < x + w) {
                c.drawCircle(xx, yy, radius, p);
                xx += step;
            }
            yy += step;
        }
    }

    protected static int alpha(int color, int a) {
        int clamped = Math.max(0, Math.min(255, a));
        return (color & 0x00FFFFFF) | (clamped << 24);
    }
}

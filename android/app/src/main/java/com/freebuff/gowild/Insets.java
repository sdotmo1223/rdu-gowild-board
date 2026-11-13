package com.freebuff.gowild;

/** The status bar and gesture bar are drawn over the design, so every layout is
 *  handed the real insets instead of guessing a padding constant. */
public final class Insets {
    public final float top;
    public final float bottom;

    public Insets(float top, float bottom) {
        this.top = top;
        this.bottom = bottom;
    }
}

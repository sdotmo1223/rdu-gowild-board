package com.freebuff.gowild;

import android.graphics.Canvas;

/** One screen direction. The host owns scrolling and insets; a design owns every
 *  pixel inside them. */
public interface Design {
    int id();

    String name();

    /** Draws the whole screen and returns the content height so the host knows how far
     *  it may scroll. */
    float draw(Canvas c, int w, int h, float scroll, Insets insets);
}

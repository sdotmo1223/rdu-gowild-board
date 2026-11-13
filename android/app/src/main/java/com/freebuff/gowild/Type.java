package com.freebuff.gowild;

import android.graphics.Typeface;

/** System families only. Samsung ships Roboto Condensed, Roboto Black and a real
 *  monospace, which is enough typographic range to carry five different systems with
 *  no font assets in the APK. */
public final class Type {
    private Type() {}

    public static final Typeface mono = Typeface.MONOSPACE;
    public static final Typeface monoBold = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD);
    public static final Typeface cond = Typeface.create("sans-serif-condensed", Typeface.NORMAL);
    public static final Typeface condBold = Typeface.create("sans-serif-condensed", Typeface.BOLD);
    public static final Typeface black = Typeface.create("sans-serif-black", Typeface.NORMAL);
    public static final Typeface serif = Typeface.create("serif", Typeface.NORMAL);
    public static final Typeface serifBold = Typeface.create("serif", Typeface.BOLD);
    public static final Typeface light = Typeface.create("sans-serif-light", Typeface.NORMAL);
}

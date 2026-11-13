package com.freebuff.gowild;

/** Prices are always formatted from the snapshot value. Never $0.01 by default,
 *  never a NaN, never an empty string. */
public final class Fmt {
    private Fmt() {}

    private static int cents(double v) {
        return (int) Math.round(v * 100.0) % 100;
    }

    public static String whole(double v) {
        return "$" + (int) Math.floor(v);
    }

    public static String frac(double v) {
        int c = cents(v);
        return c < 10 ? ".0" + c : "." + c;
    }

    public static String full(double v) {
        return whole(v) + frac(v);
    }

    /** 0 is a real answer, not an absence: a sold-out departure keeps its place.
     *  A null count is unknown, and an unknown is omitted rather than repeated down
     *  every row as "SEATS N/A" - the phone has twelve rows, not twelve disclaimers. */
    public static String seats(Integer n) {
        if (n == null) return "";
        if (n <= 0) return "SOLD OUT";
        if (n == 1) return "1 SEAT";
        return n + " SEATS";
    }

    public static String seatsShort(Integer n) {
        if (n == null) return "\u2014";
        if (n <= 0) return "0";
        return String.valueOf(n);
    }
}

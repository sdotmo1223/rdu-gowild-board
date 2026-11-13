package com.freebuff.gowild;

/** One bookable departure. Nothing here is derived on device that the board already
 *  decided: a price is what the snapshot says, and a seat count keeps 0 as sold out. */
public final class FareRow {
    public final String dep;
    public final String clock;
    public final String clock12;
    public final String dest;
    public final String city;
    public final String stops;
    public final String dur;
    public final Integer seats;
    public final double allin;
    public final String leaveBy;
    public final boolean tight;

    public FareRow(String dep, String clock, String clock12, String dest, String city, String stops,
                   String dur, Integer seats, double allin, String leaveBy, boolean tight) {
        this.dep = dep;
        this.clock = clock;
        this.clock12 = clock12;
        this.dest = dest;
        this.city = city;
        this.stops = stops;
        this.dur = dur;
        this.seats = seats;
        this.allin = allin;
        this.leaveBy = leaveBy;
        this.tight = tight;
    }
}

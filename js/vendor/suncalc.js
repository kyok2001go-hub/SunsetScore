/*
 SunCalc v2.0.1 — 经典脚本（非 ESM）版本，适配 file:// 直接打开场景
 源码取自 suncalc-master/index.js（仅保留太阳计算部分），export 改为全局 SunCalc。

 Copyright (c) 2026, Volodymyr Agafonkin
 All rights reserved.

 Redistribution and use in source and binary forms, with or without modification, are
 permitted provided that the following conditions are met:

    1. Redistributions of source code must retain the above copyright notice, this list of
       conditions and the following disclaimer.

    2. Redistributions in binary form must reproduce the above copyright notice, this list
       of conditions and the following disclaimer in the documentation and/or other
       materials provided with the distribution.

 THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY
 EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
 COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
 TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
(function (root) {
'use strict';

// shortcuts for easier to read formulas
const {PI, sin, cos, tan, asin, atan2: atan, acos, sqrt, abs, round} = Math;
const rad = PI / 180;

// date/time constants and conversions

const dayMs = 1000 * 60 * 60 * 24;
const J1970 = 2440588;
const J2000 = 2451545;

function fromJulian(j) {
    return new Date((j + 0.5 - J1970) * dayMs);
}
function toDays(date) {
    return date.valueOf() / dayMs - 0.5 + J1970 - J2000;
}

// ΔT = TT − UT in seconds (Espenak & Meeus polynomial fits, good ~1900–2150). The Meeus position
// series are defined in Terrestrial Time, but SunCalc's input Dates are UT — so the position math
// runs on days-since-J2000 shifted by deltaT, while sidereal time stays on UT. ~69 s today;
// negligible for the Sun (<0.001°), real for the Moon. d only needs ~month accuracy here (ΔT
// changes <1 s/yr), so the decimal year is derived arithmetically from d rather than from the Date.
function deltaT(d) {
    const y = 2000 + d / 365.2425;
    let t;
    if (y < 1920) { t = y - 1900; return -2.79 + t * (1.494119 + t * (-0.0598939 + t * (0.0061966 - t * 0.000197))); }
    if (y < 1941) { t = y - 1920; return 21.20 + t * (0.84493 + t * (-0.076100 + t * 0.0020936)); }
    if (y < 1961) { t = y - 1950; return 29.07 + t * (0.407 + t * (-1 / 233 + t / 2547)); }
    if (y < 1986) { t = y - 1975; return 45.45 + t * (1.067 + t * (-1 / 260 - t / 718)); }
    if (y < 2005) { t = y - 2000; return 63.86 + t * (0.3345 + t * (-0.060374 + t * (0.0017275 + t * (0.000651814 + t * 0.00002373599)))); }
    if (y < 2050) { t = y - 2000; return 62.92 + t * (0.32217 + t * 0.005589); }
    t = (y - 1820) / 100; return -20 + 32 * t * t - 0.5628 * (2150 - y);
}
function toDaysTT(d) {
    return d + deltaT(d) / 86400;
}

// general calculations for position

// north-based clockwise azimuth in degrees (0 = N, 90 = E, 180 = S, 270 = W)
function azimuth(H, phi, dec) {
    return (atan(sin(H), cos(H) * sin(phi) - tan(dec) * cos(phi)) / rad + 540) % 360;
}
function altitude(H, phi, dec) {
    return asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H));
}

// Greenwich mean sidereal time, formula 12.4 of Meeus (linear term; sub-arcsec T^2/T^3 dropped)
function siderealTime(d, lw) {
    return rad * (280.46061837 + 360.98564736629 * d) - lw;
}

function astroRefraction(h) {
    if (h < 0) h = 0; // formula valid for positive altitudes only

    // Meeus 16.4: 1.02 / tan(h + 10.26 / (h + 5.10)), h in degrees, arcmin result — folded into rad
    return 0.0002967 / tan(h + 0.00312536 / (h + 0.08901179));
}

// general sun calculations

// Sun's apparent equatorial coordinates, Meeus ch. 25. d = days since J2000 (TT); t = Julian centuries.
function sunCoords(d) {
    const t = d / 36525;
    const L0 = rad * (280.46646 + t * (36000.76983 + t * 0.0003032)); // 25.2 geometric mean longitude
    const M = rad * (357.52911 + t * (35999.05029 - t * 0.0001537)); // 25.3 mean anomaly
    const sinM = sin(M);
    const cosM = cos(M);
    const C = rad * ((1.914602 - t * (0.004817 + t * 0.000014)) * sinM + // equation of center
        (0.019993 - 0.000101 * t) * 2 * sinM * cosM + 0.000289 * sinM * (3 - 4 * sinM * sinM));
    const Om = rad * (125.04 - 1934.136 * t); // longitude of the ascending node
    const L = L0 + C - rad * (0.00569 + 0.00478 * sin(Om)); // apparent longitude (nutation + aberration)
    // 22.2 mean obliquity + 25.8 correction for apparent position
    const e = rad * (23.439291 - t * (0.0130042 + t * (0.00000016 - t * 0.000000504))) + rad * 0.00256 * cos(Om);

    return {
        ra: atan(cos(e) * sin(L), cos(L)), // 25.6
        dec: asin(sin(e) * sin(L))         // 25.7
    };
}

// calculates sun position for a given date and latitude/longitude
function getPosition(date, lat, lng) {
    const lw = rad * -lng;
    const phi = rad * lat;
    const d = toDays(date);

    const c = sunCoords(toDaysTT(d)); // position series run on Terrestrial Time
    const H = siderealTime(d, lw) - c.ra; // sidereal time stays on UT
    const h = altitude(H, phi, c.dec);

    return {
        azimuth: azimuth(H, phi, c.dec),
        // apparent (refraction-corrected) altitude in degrees
        altitude: (h + astroRefraction(h)) / rad
    };
}

// sun times configuration (angle, morning name, evening name)
const times = [
    [-0.833, 'sunrise', 'sunset'],
    [-0.3, 'sunriseEnd', 'sunsetStart'],
    [-6, 'dawn', 'dusk'],
    [-12, 'nauticalDawn', 'nauticalDusk'],
    [-18, 'nightEnd', 'night'],
    [6, 'goldenHourEnd', 'goldenHour'],
    [-4, 'goldenHourMorningEnd', 'goldenHourDusk']
];

// adds a custom time to the times config
function addTime(angle, riseName, setName) {
    times.push([angle, riseName, setName]);
}

// calculations for sun times — Meeus ch.15 (rising, transit, setting), solving the Sun's
// local hour angle directly off the same apparent coordinates (sunCoords) and sidereal time
// used by getPosition. Day offsets d are in UT days since J2000; the position series run on TT.

const J0 = 0.0009;

function observerAngle(height) {
    return -2.076 * sqrt(height) / 60;
}

// wrap an angle to (-PI, PI]
function wrapPi(a) {
    return a - 2 * PI * round(a / (2 * PI));
}

// refines a transit time so the Sun's local hour angle is zero (Meeus 15.2; dH/dd ~= 2*PI/day,
// the sidereal excess and the Sun's own motion cancelling to one solar day).
function solarTransit(dt, lw) {
    for (let i = 0; i < 3; i++) {
        const H = wrapPi(siderealTime(dt, lw) - sunCoords(toDaysTT(dt)).ra);
        dt -= H / (2 * PI);
    }
    return dt;
}

// time the Sun reaches altitude h0 on the given side of transit (sign -1 = rise, +1 = set);
// starts from the hour angle at transit and converges with Meeus' altitude correction (15.2).
function getSetJ(h0, dt, sign, lw, phi, decT) {
    const cosH0 = (sin(h0) - sin(phi) * sin(decT)) / (cos(phi) * cos(decT));
    if (cosH0 < -1 || cosH0 > 1) return NaN; // sun stays above / below this altitude all day

    let d = dt + sign * acos(cosH0) / (2 * PI);
    for (let i = 0; i < 2; i++) {
        const c = sunCoords(toDaysTT(d));
        const H = wrapPi(siderealTime(d, lw) - c.ra);
        const h = altitude(H, phi, c.dec);
        const sinH = cos(phi) * cos(c.dec) * sin(H);
        if (abs(sinH) < 1e-6) break; // grazing the horizon — correction is ill-conditioned
        d += (h - h0) / (2 * PI * sinH);
    }
    return d;
}

// calculates sun times for a given date, latitude/longitude, and, optionally,
// the observer height (in meters) relative to the horizon

function getTimes(date, lat, lng, height = 0) {

    const lw = rad * -lng;
    const phi = rad * lat;
    const dh = observerAngle(height);
    // Anchor to the input date's UTC solar day regardless of its time-of-day, killing the historical
    // "always pass noon" footgun where an early-morning Date returned the previous day's events:
    // round to that day's noon, offset to the nearest local solar noon, then let solarTransit refine.
    const d = round(round(toDays(date)) - J0 - lw / (2 * PI));
    const dt = solarTransit(d + J0 + lw / (2 * PI), lw);
    const dec = sunCoords(toDaysTT(dt)).dec; // declination at transit, shared by every rise/set solve

    const result = {
        solarNoon: fromJulian(dt + J2000),
        nadir: fromJulian(dt + J2000 - 0.5)
    };

    for (const [angle, riseName, setName] of times) {
        const h0 = (angle + dh) * rad;
        const jrise = getSetJ(h0, dt, -1, lw, phi, dec);
        const jset = getSetJ(h0, dt, 1, lw, phi, dec);

        // a NaN means the Sun never reaches this altitude on this day — report null, not Invalid Date
        result[riseName] = Number.isNaN(jrise) ? null : fromJulian(jrise + J2000);
        result[setName] = Number.isNaN(jset) ? null : fromJulian(jset + J2000);
    }

    // polar day/night: when the Sun never crosses the standard rise/set altitude, flag which side it
    // stays on by comparing its altitude at solar noon (its daily maximum) against that threshold.
    if (result.sunrise === null) {
        const noonAlt = altitude(0, phi, dec);
        const riseSetAlt = (times[0][0] + dh) * rad;
        result.alwaysUp = noonAlt > riseSetAlt;
        result.alwaysDown = noonAlt <= riseSetAlt;
    }

    return result;
}

root.SunCalc = {
    getPosition: getPosition,
    getTimes: getTimes,
    addTime: addTime,
    times: times
};
})(typeof window !== 'undefined' ? window : globalThis);

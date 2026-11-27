/**
 * What the API hands the print bridge. The API lays a printout out as lines of fixed-width text for the
 * printer's paper; the bridge only turns the lines into printer commands. A change to a receipt therefore
 * never needs the bridge at an outlet to be updated.
 */
export const PAPER_COLUMNS = { MM58: 32, MM80: 48 };
//# sourceMappingURL=printing.js.map
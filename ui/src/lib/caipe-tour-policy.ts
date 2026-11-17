import { PRODUCT_TOURS, isProductTourId, type ProductTourId } from "@/lib/product-tour-catalog";

export const ALL_PRODUCT_TOUR_IDS = Object.keys(PRODUCT_TOURS) as ProductTourId[];

/** Missing policy preserves existing installations; an explicit empty list hides every tour. */
export function normalizeEnabledTours(value: unknown, strict = false): ProductTourId[] {
  if (value === undefined && !strict) return [...ALL_PRODUCT_TOUR_IDS];
  if (!Array.isArray(value) || value.some((id) => !isProductTourId(id))) {
    if (strict) throw new Error("enabled_tours must contain only known CAIPE Tour IDs");
    return [];
  }
  return ALL_PRODUCT_TOUR_IDS.filter((id) => value.includes(id));
}

/** An absent runtime switch keeps existing installations enabled. */
export function isCaipeTourEnabled(value: unknown): boolean {
  return value === undefined || value === true;
}

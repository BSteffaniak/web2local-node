/**
 * @web2local/scraper
 *
 * Source map extraction and file reconstruction
 */

// From scraper.ts
export {
    type BundleInfo,
    type VendorBundle,
    type ScrapedRedirect,
    type ExtractBundleUrlsResult,
    type SourceMapCheckResult,
    type BundleWithContent,
    type SourceMapSearchResult,
    extractBundleUrls,
    findSourceMapUrl,
    findAllSourceMaps,
} from './scraper.js';

// From sourcemap.ts
export {
    type SourceFile,
    type SourceMapResult,
    extractSourcesFromMap,
} from './sourcemap.js';

// From reconstructor.ts
export {
    type ReconstructionOptions,
    type ReconstructionResult,
    reconstructSources,
    writeManifest,
    getBundleName,
    saveBundles,
    generateBundleStubs,
    sanitizePath,
    type BundleManifest,
    type SavedBundle,
} from './reconstructor.js';

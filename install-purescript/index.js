'use strict';

const {constants: {BROTLI_PARAM_SIZE_HINT}, brotliCompress, createBrotliDecompress} = require('zlib');
const {createReadStream, lstat, stat} = require('fs');
const {execFile} = require('child_process');
const {join, normalize} = require('path');
const {promisify} = require('util');
const {Writable} = require('stream');

const arch = require('arch');
const {create, Unpack} = require('tar');
const {get: {info: getCacheInfo}, put: putCache, rm: {entry: removeCache}, tmp: {withTmp}, verify} = require('npcache');
const inspectWithKind = require('inspect-with-kind');
const isPlainObj = require('is-plain-obj');
const Observable = require('zen-observable');
const pump = require('pump');
const runInDir = require('run-in-dir');

const downloadOrBuildPurescript = require('../download-or-build-purescript/index.js');

function addId(obj, id) {
	Object.defineProperty(obj, 'id', {
		value: id,
		writable: true
	});

	return obj;
}

const CACHE_KEY = 'install-purescript:binary';
const MAX_READ_SIZE = 30 * 1024 * 1024;
const defaultBinName = `purs${process.platform === 'win32' ? '.exe' : ''}`;
const cacheIdSuffix = `-${process.platform}-${arch()}`;

module.exports = function installPurescript(...args) {
	return new Observable(observer => {
		const argLen = args.length;

		if (argLen > 1) {
			const error = new RangeError(`Exepcted 0 or 1 argument ([<Object>]), but got ${argLen} arguments.`);

			error.code = 'ERR_TOO_MANY_ARGS';
			throw error;
		}

		const [options = {}] = args;

		if (args.length === 1) {
			if (!isPlainObj(options)) {
				throw new TypeError(`Expected an object to set install-purescript options, but got ${
					inspectWithKind(options)
				}.`);
			}

			if (options.forceReinstall !== undefined && typeof options.forceReinstall !== 'boolean') {
				throw new TypeError(`Expected \`forceReinstall\` option to be a Boolean value, but got ${
					inspectWithKind(options.forceReinstall)
				}.`);
			}
		}

		const subscriptions = new Set();

		function cancelInstallation() {
			for (const subscription of subscriptions) {
				subscription.unsubscribe();
			}
		}

		const binName = typeof options.rename === 'function' ? normalize(`${options.rename(defaultBinName)}`) : defaultBinName;
		const cwd = process.cwd();
		const binPath = join(cwd, binName);
		const cacheId = `${options.version || downloadOrBuildPurescript.defaultVersion}${cacheIdSuffix}`;

		function main({brokenCacheFound = false} = {}) {
			const cacheCleaning = (async () => {
				if (brokenCacheFound) {
					try {
						await removeCache(CACHE_KEY);
					} catch {}
				}

				try {
					await verify();
				} catch {}
			})();

			runInDir(cwd, () => subscriptions.add(downloadOrBuildPurescript(options).subscribe({
				next(val) {
					observer.next(val);
				},
				async error(err) {
					await cacheCleaning;
					observer.error(err);
				},
				async complete() {
					const writeCacheValue = {id: 'write-cache'};
					const tarBuffers = [];
					const tarCreateOptions = {
						cwd,
						maxReadSize: MAX_READ_SIZE,
						noDirRecurse: true,
						strict: true,
						statCache: new Map()
					};
					let tarSize = 0;

					try {
						const binStat = await promisify(lstat)(binPath);

						tarCreateOptions.statCache.set(binPath, binStat);
						writeCacheValue.originalSize = binStat.size;
					} catch {}

					observer.next(writeCacheValue);

					try {
						await Promise.all([
							promisify(pump)(create(tarCreateOptions, [binName]), new Writable({
								write(data, _, cb) {
									tarBuffers.push(data);
									tarSize += data.length;
									cb();
								}
							})),
							(async () => {
								await cacheCleaning;

								// Ensure the path where the current npm config regards as a cache directory
								// is actually available, before performing long-running compression
								await withTmp(async () => {});
							})()
						]);
						const decomressed = await promisify(brotliCompress)(Buffer.concat(tarBuffers, tarSize), {
							params: {
								[BROTLI_PARAM_SIZE_HINT]: tarSize
							}
						});
						await putCache(CACHE_KEY, decomressed, {
							size: decomressed.size,
							metadata: {
								id: cacheId
							}
						});
					} catch (err) {
						observer.next({
							id: 'write-cache:fail',
							error: addId(err, 'write-cache')
						});
						observer.complete();

						return;
					}

					observer.next({id: 'write-cache:complete'});
					observer.complete();
				}
			})));
		}

		if (options.forceReinstall) {
			main();
			return cancelInstallation;
		}

		const tmpSubscription = downloadOrBuildPurescript(options).subscribe({
			error(err) {
				observer.error(err);
			}
		});

		(async () => {
			const searchCacheValue = {
				id: 'search-cache',
				found: false
			};
			let id;
			let cachePath;

			try {
				const [info] = await Promise.all([
					getCacheInfo(CACHE_KEY),
					(async () => {
						await promisify(setImmediate)();
						tmpSubscription.unsubscribe();
					})(),
					(async () => {
						try {
							if ((await promisify(stat)(binPath)).isDirectory()) {
								const error = new Error(`Tried to create a PureScript binary at ${binPath}, but a directory already exists there.`);

								error.code = 'EISDIR';
								error.path = binPath;
								observer.error(error);
							}
						} catch (_) {}
					})()
				]);

				id = info.metadata.id;
				cachePath = info.path;
			} catch (_) {
				if (observer.closed) {
					return;
				}

				observer.next(searchCacheValue);
				main();

				return;
			}

			if (observer.closed) {
				return;
			}

			if (id !== cacheId) {
				observer.next(searchCacheValue);
				main({brokenCacheFound: true});
				return;
			}

			searchCacheValue.found = true;
			searchCacheValue.path = cachePath;
			observer.next(searchCacheValue);
			observer.next({id: 'restore-cache'});

			try {
				let fileCount = 0;

				await promisify(pump)(createReadStream(cachePath), createBrotliDecompress(), new Unpack({
					strict: true,
					cwd,
					filter(_, entry) {
						entry.path = binName;
						entry.header.path = binName;
						entry.absolute = binPath;

						const isFile = entry.type === 'File';

						fileCount += Number(isFile);
						return isFile;
					}
				}));

				if (fileCount !== 1) {
					const error = new Error(`Expected a cached PureScript binary archive ${cachePath} contains 1 file, but found ${fileCount}.`);

					error.code = 'EINVALIDCACHE';
					throw error;
				}
			} catch (err) {
				observer.next({
					id: 'restore-cache:fail',
					error: addId(err, 'restore-cache')
				});

				main({brokenCacheFound: true});
				return;
			}

			observer.next({id: 'restore-cache:complete'});
			observer.next({id: 'check-binary'});

			try {
				await promisify(execFile)(binPath, ['--version'], {timeout: 8000, ...options});
			} catch (err) {
				observer.next({
					id: 'check-binary:fail',
					error: addId(err, 'check-binary')
				});

				main({brokenCacheFound: true});
				return;
			}

			observer.next({id: 'check-binary:complete'});
			observer.complete();
		})();

		return cancelInstallation;
	});
};

Object.defineProperties(module.exports, {
	cacheKey: {
		enumerable: true,
		value: CACHE_KEY
	},
	defaultVersion: {
		enumerable: true,
		value: downloadOrBuildPurescript.defaultVersion
	},
	supportedBuildFlags: {
		enumerable: true,
		value: downloadOrBuildPurescript.supportedBuildFlags
	}
});
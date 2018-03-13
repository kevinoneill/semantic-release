const {isUndefined} = require('lodash');
const semver = require('semver');

/**
 * Last release.
 *
 * @typedef {Object} LastRelease
 * @property {string} version The version number of the last release.
 * @property {string} [gitHead] The Git reference used to make the last release.
 */

/**
 * Determine the Git tag and version of the last tagged release.
 *
 * - Filter out the branch tags that are not valid semantic version
 * - Sort the versions
 * - Retrive the highest version
 *
 * @param {Object} branch The branch object for the current branch.
 * @param {String} branch.name The branch name.
 * @param {Array<Object>} branch.tags The branch tags.
 * @param {String} branch.type The branch type.
 * @param {Object} logger Global logger.
 * @param {Object} options Options.
 * @param {Object} options.before Find only releases with version number lower than this version.
 * @return {LastRelease} The last tagged release or empty object if none is found.
 */
module.exports = ({name, tags, type}, logger, {before} = {}) => {
  const [{version, gitTag, gitHead, channel} = {}] = tags
    .filter(tag => type === 'prerelease' || !semver.prerelease(tag.version))
    .filter(tag => isUndefined(before) || semver.lt(tag.version, before))
    .sort((a, b) => semver.rcompare(a.version, b.version));

  if (gitTag) {
    logger.log('Found git tag %s associated with version %s on branch %s', gitTag, version, name);
    return {version, gitTag, gitHead, channel};
  }

  logger.log('No git tag version found on branch %s', name);
  return {};
};

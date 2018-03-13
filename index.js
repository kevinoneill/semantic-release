const {isPlainObject, castArray} = require('lodash');
const marked = require('marked');
const TerminalRenderer = require('marked-terminal');
const envCi = require('env-ci');
const hookStd = require('hook-std');
const pReduce = require('p-reduce');
const pkg = require('./package.json');
const hideSensitive = require('./lib/hide-sensitive');
const getConfig = require('./lib/get-config');
const verify = require('./lib/verify');
const getNextVersion = require('./lib/get-next-version');
const getCommits = require('./lib/get-commits');
const getLastRelease = require('./lib/get-last-release');
const getReleasesToAdd = require('./lib/get-releases-to-add');
const {extractErrors, makeTag} = require('./lib/utils');
const getGitAuthUrl = require('./lib/get-git-auth-url');
const logger = require('./lib/logger');
const {verifyAuth, isBranchUpToDate, gitHead: getGitHead, tag, push} = require('./lib/git');
const getError = require('./lib/get-error');
const {COMMIT_NAME, COMMIT_EMAIL} = require('./lib/definitions/constants');

marked.setOptions({renderer: new TerminalRenderer()});

async function run(options, plugins) {
  const {isCi, branch: ciBranch, isPr} = envCi();

  if (!isCi && !options.dryRun && !options.noCi) {
    logger.log('This run was not triggered in a known CI environment, running in dry-run mode.');
    options.dryRun = true;
  } else {
    // When running on CI, set the commits author and commiter info and prevent the `git` CLI to prompt for username/password. See #703.
    process.env = {
      GIT_AUTHOR_NAME: COMMIT_NAME,
      GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
      GIT_COMMITTER_NAME: COMMIT_NAME,
      GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
      ...process.env,
      GIT_ASKPASS: 'echo',
      GIT_TERMINAL_PROMPT: 0,
    };
  }

  if (isCi && isPr && !options.noCi) {
    logger.log("This run was triggered by a pull request and therefore a new version won't be published.");
    return;
  }

  // Verify config
  await verify(options);

  const branch = options.branches.find(({name}) => name === ciBranch);

  if (!branch) {
    logger.log(
      `This test run was triggered on the branch ${ciBranch}, while semantic-release is configured to only publish from ${options.branches
        .map(({name}) => name)
        .join(', ')}, therefore a new version won’t be published.`
    );
    return false;
  }

  const {repositoryUrl} = options;
  options.repositoryUrl = await getGitAuthUrl(options, branch.name);

  if (!(await isBranchUpToDate(branch.name))) {
    logger.log(
      "The local branch %s is behind the remote one, therefore a new version won't be published.",
      branch.name
    );
    return false;
  }

  try {
    await verifyAuth(options.repositoryUrl, branch.name);
  } catch (err) {
    logger.error(`The command "${err.cmd}" failed with the error message %s.`, err.stderr);
    throw getError('EGITNOPERMISSION', {options, repositoryUrl});
  }

  logger.log('Run automated release from branch %s', ciBranch);
  logger.log('Call plugin %s', 'verify-conditions');
  await plugins.verifyConditions({options, logger}, {settleAll: true});

  const releases = [];
  const releasesToAdd = getReleasesToAdd(branch, options, logger);

  await pReduce(releasesToAdd, async (_, {lastRelease, currentRelease, nextRelease}) => {
    // TODO verif if in range => stop here or continue to release what's valid?
    const commits = await getCommits(lastRelease.gitHead, nextRelease.gitHead, branch.name, logger);
    [nextRelease.notes] = await plugins.generateNotes({options, logger, lastRelease, commits, nextRelease});

    logger.log('Create tag %s', nextRelease.gitTag);
    await tag(nextRelease.gitTag);
    await push(options.repositoryUrl, branch.name);

    releases.push(
      ...(await plugins.addChannel(
        {options, logger, lastRelease, commits, currentRelease, nextRelease},
        // Add nextRelease and plugin properties to published release
        {transform: (release, step) => ({...(isPlainObject(release) ? release : {}), ...nextRelease, ...step})}
      ))
    );
  });

  const lastRelease = getLastRelease(branch, logger);

  const {channel} = branch;
  const commits = await getCommits(lastRelease.gitHead, 'HEAD', branch.name, logger);

  logger.log('Call plugin %s', 'analyze-commits');
  const [type] = await plugins.analyzeCommits({
    options,
    logger,
    lastRelease,
    commits: commits.filter(commit => !/\[skip\s+release\]|\[release\s+skip\]/i.test(commit.message)),
  });

  if (!type) {
    logger.log('There are no relevant changes, so no new version is released.');
    return;
  }

  const version = getNextVersion(branch, type, lastRelease, logger);
  // TODO verify if release match branch range (even it's a downstream merge)

  const nextRelease = {
    type,
    version,
    channel,
    gitHead: await getGitHead(),
    gitTag: makeTag(options.tagFormat, version, channel),
    name: makeTag(options.tagFormat, version),
  };

  logger.log('Call plugin %s', 'verify-release');
  await plugins.verifyRelease({options, logger, lastRelease, commits, nextRelease}, {settleAll: true});

  const generateNotesParam = {options, logger, lastRelease, commits, nextRelease};

  if (options.dryRun) {
    logger.log('Call plugin %s', 'generate-notes');
    const [notes] = await plugins.generateNotes(generateNotesParam);
    logger.log('Release note for version %s:\n', nextRelease.version);
    process.stdout.write(`${marked(notes)}\n`);
  } else {
    logger.log('Call plugin %s', 'generateNotes');
    [nextRelease.notes] = await plugins.generateNotes(generateNotesParam);

    logger.log('Call plugin %s', 'prepare');
    await plugins.prepare(
      {options, logger, lastRelease, commits, nextRelease},
      {
        getNextInput: async lastResult => {
          const newGitHead = await getGitHead();
          // If previous prepare plugin has created a commit (gitHead changed)
          if (lastResult.nextRelease.gitHead !== newGitHead) {
            nextRelease.gitHead = newGitHead;
            // Regenerate the release notes
            logger.log('Call plugin %s', 'generateNotes');
            [nextRelease.notes] = await plugins.generateNotes(generateNotesParam);
          }
          // Call the next publish plugin with the updated `nextRelease`
          return {options, logger, lastRelease, commits, nextRelease};
        },
      }
    );

    // Create the tag before calling the publish plugins as some require the tag to exists
    logger.log('Create tag %s', nextRelease.gitTag);
    await tag(nextRelease.gitTag);
    await push(options.repositoryUrl, branch.name);

    logger.log('Call plugin %s', 'publish');
    releases.push(
      ...(await plugins.publish(
        {options, logger, lastRelease, commits, nextRelease},
        // Add nextRelease and plugin properties to published release
        {transform: (release, step) => ({...(isPlainObject(release) ? release : {}), ...nextRelease, ...step})}
      ))
    );

    logger.log('Published release: %s', nextRelease.version);

    await plugins.success({options, logger, lastRelease, commits, nextRelease, releases}, {settleAll: true});
  }
  return true;
}

function logErrors(err) {
  const errors = extractErrors(err).sort(error => (error.semanticRelease ? -1 : 0));
  for (const error of errors) {
    if (error.semanticRelease) {
      logger.log(`%s ${error.message}`, error.code);
      if (error.details) {
        process.stdout.write(`${marked(error.details)}\n`);
      }
    } else {
      logger.error('An error occurred while running semantic-release: %O', error);
    }
  }
}

async function callFail(plugins, options, error) {
  const errors = extractErrors(error).filter(error => error.semanticRelease);
  if (errors.length > 0) {
    try {
      await plugins.fail({options, logger, errors}, {settleAll: true});
    } catch (err) {
      logErrors(err);
    }
  }
}

module.exports = async opts => {
  logger.log(`Running %s version %s`, pkg.name, pkg.version);
  const unhook = hookStd({silent: false}, hideSensitive);
  try {
    const config = await getConfig(opts, logger);
    const {plugins, options} = config;
    try {
      const result = await run(options, plugins);
      unhook();
      return result;
    } catch (err) {
      if (!options.dryRun) {
        await callFail(plugins, options, err);
      }
      throw err;
    }
  } catch (err) {
    logErrors(err);
    unhook();
    throw err;
  }
};

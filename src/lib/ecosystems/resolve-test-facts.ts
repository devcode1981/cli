import { Options, PolicyOptions } from '../types';
import { spinner } from '../../lib/spinner';
import {
  Ecosystem,
  ScanResult,
  TestResult,
  FileSignaturesDetails,
} from './types';
import {
  CreateDepGraphResponse,
  GetIssuesResponse,
  FileHashes,
  Attributes,
} from './unmanaged/types';
import {
  requestTestPollingToken,
  pollingTestWithTokenUntilDone,
  createDepGraph,
  getDepGraph,
  getIssues,
} from '../polling/polling-test';
import { extractAndApplyPluginAnalytics } from './plugin-analytics';
import { findAndLoadPolicy } from '../policy';
import { filterIgnoredIssues } from './policy';
import { IssueData, Issue } from '../snyk-test/legacy';
import { hasFeatureFlag } from '../feature-flags';
import {
  convertDepGraph,
  convertMapCasing,
  convertToCamelCase,
  getSelf,
} from './unmanaged/utils';
import { sleep } from '../common';

export async function resolveAndTestFacts(
  ecosystem: Ecosystem,
  scans: {
    [dir: string]: ScanResult[];
  },
  options: Options & PolicyOptions,
): Promise<[TestResult[], string[]]> {
  const unmanagedDepsOverride = process.env.USE_UNMANAGED_DEPS;

  const featureFlagEnabled = await hasFeatureFlag(
    'snykNewUnmanagedTest',
    options,
  );

  return featureFlagEnabled || unmanagedDepsOverride
    ? resolveAndTestFactsUnmanagedDeps(scans, options)
    : resolveAndTestFactsRegistry(ecosystem, scans, options);
}

async function submitHashes(
  hashes: FileHashes,
  orgId: string,
): Promise<string> {
  const response: CreateDepGraphResponse = await createDepGraph(hashes, orgId);

  return response.data.id;
}

async function pollDepGraphAttributes(
  id: string,
  orgId: string,
): Promise<Attributes> {
  const maxIntervalMs = 60000;
  const minIntervalMs = 5000;

  const maxAttempts = 31; // Corresponds to 25.5 minutes

  // Loop until we receive a response that is not in progress,
  // or we receive something else than http status code 200.
  for (let i = 1; i <= maxAttempts; i++) {
    const graph = await getDepGraph(id, orgId);

    if (graph.data.attributes.in_progress) {
      const pollInterval = Math.max(maxIntervalMs, minIntervalMs * i);
      await sleep(pollInterval * i);

      continue;
    }

    return graph.data.attributes;
  }

  throw new Error('max retries reached');
}

async function fetchIssues(
  start_time,
  dep_graph_data,
  component_details,
  orgId: string,
) {
  const response: GetIssuesResponse = await getIssues(
    {
      dep_graph: dep_graph_data,
      start_time,
      component_details,
    },
    orgId,
  );

  const issues = response.data.result.issues.map((issue) => {
    const converted = convertToCamelCase<Issue>(issue);
    converted.fixInfo = convertToCamelCase(converted.fixInfo);
    return converted;
  });

  const issuesData = convertMapCasing<{
    [issueId: string]: IssueData;
  }>(response.data.result.issues_data);

  const depGraphData = convertDepGraph(response.data.result.dep_graph);

  const dependencyCount = response.data.result.dep_graph.graph.nodes.find(
    (graphNode) => {
      return graphNode.node_id === 'root-node';
    },
  )?.deps?.length;

  const depsFilePaths = response.data.result.deps_file_paths;

  const fileSignaturesDetails = convertMapCasing<FileSignaturesDetails>(
    response.data.result.file_signatures_details,
  );

  return {
    issues,
    issuesData,
    depGraphData,
    dependencyCount,
    depsFilePaths,
    fileSignaturesDetails,
  };
}

export async function resolveAndTestFactsUnmanagedDeps(
  scans: {
    [dir: string]: ScanResult[];
  },
  options: Options & PolicyOptions,
): Promise<[TestResult[], string[]]> {
  const results: any[] = [];
  const errors: string[] = [];
  const packageManager = 'Unmanaged (C/C++)';

  let orgId = options.org || '';

  if (orgId === '') {
    const self = await getSelf();
    orgId = self.default_org_context;
  }

  for (const [path, scanResults] of Object.entries(scans)) {
    await spinner(`Resolving and Testing fileSignatures in ${path}`);

    for (const scanResult of scanResults) {
      try {
        const id = await submitHashes(
          { hashes: scanResult?.facts[0]?.data },
          orgId,
        );

        const {
          start_time,
          dep_graph_data,
          component_details,
        } = await pollDepGraphAttributes(id, orgId);

        const {
          issues,
          issuesData,
          depGraphData,
          dependencyCount,
          depsFilePaths,
          fileSignaturesDetails,
        } = await fetchIssues(
          start_time,
          dep_graph_data,
          component_details,
          orgId,
        );

        const issuesMap: Map<string, Issue> = new Map();
        issues.forEach((i) => {
          issuesMap[i.issueId] = i;
        });

        const vulnerabilities: IssueData[] = [];
        for (const issuesDataKey in issuesData) {
          const pkgCoordinate = `${issuesMap[issuesDataKey]?.pkgName}@${issuesMap[issuesDataKey]?.pkgVersion}`;
          const issueData = issuesData[issuesDataKey];

          issueData.from = [pkgCoordinate];
          issueData.name = pkgCoordinate;
          issueData.packageManager = packageManager;

          vulnerabilities.push(issueData);
        }

        const policy = await findAndLoadPolicy(path, 'cpp', options);

        const [issuesFiltered, issuesDataFiltered] = filterIgnoredIssues(
          issues,
          issuesData,
          policy,
        );

        results.push({
          issues: issuesFiltered,
          issuesData: issuesDataFiltered,
          depGraphData,
          depsFilePaths,
          fileSignaturesDetails,
          vulnerabilities,
          path,
          dependencyCount,
          packageManager,
        });
      } catch (error) {
        const hasStatusCodeError = error.code >= 400 && error.code <= 500;
        if (hasStatusCodeError) {
          errors.push(error.message);
          continue;
        }

        const failedPath = path ? `in ${path}` : '.';
        errors.push(`Could not test dependencies ${failedPath}`);
      }
    }
  }
  spinner.clearAll();
  return [results, errors];
}

export async function resolveAndTestFactsRegistry(
  ecosystem: Ecosystem,
  scans: {
    [dir: string]: ScanResult[];
  },
  options: Options & PolicyOptions,
): Promise<[TestResult[], string[]]> {
  const results: any[] = [];
  const errors: string[] = [];
  const packageManager = 'Unmanaged (C/C++)';

  for (const [path, scanResults] of Object.entries(scans)) {
    await spinner(`Resolving and Testing fileSignatures in ${path}`);
    for (const scanResult of scanResults) {
      try {
        const res = await requestTestPollingToken(options, true, scanResult);
        if (scanResult.analytics) {
          extractAndApplyPluginAnalytics(scanResult.analytics, res.token);
        }
        const { maxAttempts, pollInterval } = res.pollingTask;
        const attemptsCount = 0;
        const response = await pollingTestWithTokenUntilDone(
          res.token,
          ecosystem,
          options,
          pollInterval,
          attemptsCount,
          maxAttempts,
        );

        const policy = await findAndLoadPolicy(path, 'cpp', options);
        const [issues, issuesData] = filterIgnoredIssues(
          response.issues,
          response.issuesData,
          policy,
        );

        const issuesMap: Map<string, Issue> = new Map();
        response.issues.forEach((i) => {
          issuesMap[i.issueId] = i;
        });

        const vulnerabilities: IssueData[] = [];
        for (const issuesDataKey in response.issuesData) {
          if (issuesMap[issuesDataKey]) {
            const issueData = response.issuesData[issuesDataKey];
            const pkgCoordinate = `${issuesMap[issuesDataKey].pkgName}@${issuesMap[issuesDataKey].pkgVersion}`;
            issueData.from = [pkgCoordinate];
            issueData.name = pkgCoordinate;
            issueData.packageManager = packageManager;
            vulnerabilities.push(issueData);
          }
        }

        const dependencyCount = response?.depGraphData?.graph?.nodes?.find(
          (graphNode) => {
            return graphNode.nodeId === 'root-node';
          },
        )?.deps?.length;

        results.push({
          issues,
          issuesData,
          depGraphData: response?.depGraphData,
          depsFilePaths: response?.depsFilePaths,
          fileSignaturesDetails: response?.fileSignaturesDetails,
          vulnerabilities,
          path,
          dependencyCount,
          packageManager,
        });
      } catch (error) {
        const hasStatusCodeError = error.code >= 400 && error.code <= 500;
        if (hasStatusCodeError) {
          errors.push(error.message);
          continue;
        }
        const failedPath = path ? `in ${path}` : '.';
        errors.push(`Could not test dependencies ${failedPath}`);
      }
    }
  }
  spinner.clearAll();
  return [results, errors];
}

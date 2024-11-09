import * as core from "@actions/core";
import * as github from "@actions/github";
import { Logger } from "tslog";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config(); // Load .env file

// Initialize logger
const logLevel = core.getInput("log-level") || "info";
const logger = new Logger({ name: "Code Review", minLevel: logLevel });

function checkRequiredEnvVars() {
  const requiredEnvVars = [
    "GEMINI_API_KEY",
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_PULL_REQUEST_NUMBER",
    "GIT_COMMIT_HASH",
  ];
  requiredEnvVars.forEach((envVar) => {
    if (!process.env[envVar]) {
      throw new Error(`${envVar} is not set`);
    }
  });
}

// Generate the review prompt
function getReviewPrompt(extraPrompt = "") {
  return `
    This is a pull request or part of a pull request if the pull request is very large.
    Suppose you review this PR as an excellent software engineer and an excellent security engineer.
    Can you tell me the issues with differences in a pull request and provide suggestions to improve it?
    You can provide a review summary and issue comments per file if any major issues are found.
    Always include the name of the file that is citing the improvement or problem.
    ${extraPrompt}
  `;
}

// Generate the summary prompt
function getSummarizePrompt() {
  return `
    Can you summarize this for me?
    It would be good to stick to highlighting pressing issues and providing code suggestions to improve the pull request.
    Here's what you need to summarize:
  `;
}

// Create a comment on the pull request
async function createCommentToPullRequest(
  githubToken,
  githubRepository,
  pullRequestNumber,
  gitCommitHash,
  body
) {
  const url = `/repos/${githubRepository}/pulls/${pullRequestNumber}/reviews`;
  const headers = {
    Accept: "application/vnd.github.v3+json",
    Authorization: `Bearer ${githubToken}`,
  };

  const data = {
    body,
    commit_id: gitCommitHash,
    event: "COMMENT",
  };

  try {
    const response = await github
      .getOctokit(githubToken)
      .request('POST ' + url, {
        headers,
        ...data,
      });
    return response.data;
  } catch (error) {
    logger.error("Error posting comment: ", error);
    throw error;
  }
}

// Chunk the string into smaller parts
function chunkString(inputString, chunkSize) {
  const chunkedInputs = [];
  for (let i = 0; i < inputString.length; i += chunkSize) {
    chunkedInputs.push(inputString.slice(i, i + chunkSize));
  }
  return chunkedInputs;
}

async function getReview(
  model,
  diff,
  extraPrompt,
  promptChunkSize
) {
  const reviewPrompt = getReviewPrompt(extraPrompt);
  const chunkedDiffList = chunkString(diff, promptChunkSize);
  const geminiApiKey = process.env.GEMINI_API_KEY;

  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const modelInstance = await genAI.getGenerativeModel({ model });
  const chunkedReviews = [];

  // logger.debug(`Diff: ${diff}`);
  // logger.debug(`Prompt: ${reviewPrompt}`);
  for (const chunk of chunkedDiffList) {
    try {
      const result = await modelInstance.generateContent(reviewPrompt + chunk);

      const response = result.response;
      const reviewResult = response.text();
      // const reviewResult = reviewPrompt + chunk;
      logger.debug(`Response AI: ${reviewResult}`);
      chunkedReviews.push(reviewResult);
    } catch (error) {
      logger.error("Error generating review for chunk: ", error);
      throw error;
    }
  }

  const summarizePrompt =
    chunkedReviews.length === 0
      ? "Say that you didn't find any relevant changes to comment on any file"
      : getSummarizePrompt();
  const chunkedReviewsJoin = chunkedReviews.join("\n");

  try {
    const summarizeResult = await modelInstance.generateContent(
      summarizePrompt + "\n\n" + chunkedReviewsJoin
    );
    const summarizedReview = summarizeResult.response.text();
    // const summarizedReview = summarizePrompt + "\n\n" + chunkedReviewsJoin;
    logger.debug(`Response AI (summary): ${summarizedReview}`);
    return [chunkedReviews, summarizedReview];
  } catch (error) {
    logger.error("Error summarizing the review: ", error);
    throw error;
  }
}

// Format the review comment for GitHub
function formatReviewComment(summarizedReview, chunkedReviews) {
  if (chunkedReviews.length === 1) {
    return summarizedReview;
  }
  const unionedReviews = chunkedReviews.join("\n");

  // Ensure the summary content is properly closed in case it was missing the closing tag
  const safeSummary = summarizedReview.endsWith("</summary>") ? summarizedReview : `${summarizedReview}</summary>`;

  return `
    <details>
        <summary>${safeSummary}</summary>
        ${unionedReviews}
    </details>
  `;
}

// Main function for GitHub Action
async function main() {
  checkRequiredEnvVars();

  const diff = core.getInput("pull_request_diff");
  const diffChunkSize = parseInt(core.getInput("pull_request_chunk_size"), 10);
  const model = core.getInput("model") || "gemini-1.5-pro-latest";
  const extraPrompt = core.getInput("extra-prompt") || "";

  const [chunkedReviews, summarizedReview] = await getReview(
    model,
    diff,
    extraPrompt,
    diffChunkSize
  );
  const reviewComment = formatReviewComment(summarizedReview, chunkedReviews);
  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepository = process.env.GITHUB_REPOSITORY;
  const pullRequestNumber = parseInt(
    process.env.GITHUB_PULL_REQUEST_NUMBER || "",
    10
  );
  const gitCommitHash = process.env.GIT_COMMIT_HASH || "";

  await createCommentToPullRequest(
    githubToken,
    githubRepository,
    pullRequestNumber,
    gitCommitHash,
    reviewComment
  );
}

main().catch((error) => {
  logger.error("Error during execution details: ", error);
});

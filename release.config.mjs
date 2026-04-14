/** @type {import('semantic-release').GlobalConfig} */
export default {
  branches: ["main"],
  tagFormat: ["v", "$", "{version}"].join(""),
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    [
      "@semantic-release/github",
      {
        successComment: false,
        failComment: false,
      },
    ],
  ],
};

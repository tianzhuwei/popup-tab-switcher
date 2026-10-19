const path = require("path");
const webpack = require("webpack");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const deepmerge = require("deepmerge");
const { exec } = require("child_process");

const buildProdDir = path.join(__dirname, "build-prod");
// Chrome loads the unpacked extension from this directory,
// so dev builds output directly there (auto-overwrite on rebuild).
const buildDevDir = "/Applications/01-CrhomeExtension/TabPop";
const srcDir = path.join(__dirname, "src");
const settingsDir = path.join(srcDir, "settings");
const stylesDir = path.join(srcDir, "styles");
const nodeModulesDir = path.join(__dirname, "node_modules");
const conf = {
  mode: "development",
  devtool: false,

  entry: {
    background: "./src/background.ts",
    content: "./src/content-script/index.ts",
    settings: {
      import: "./src/settings/index.ts",
      filename: "settings/index.js",
    },
    preview: {
      import: "./src/preview/index.ts",
      filename: "preview/index.js",
    },
  },

  output: {
    filename: "[name].js",
    path: buildDevDir,
  },

  module: {
    rules: [
      {
        exclude: nodeModulesDir,
        test: /\.tsx?$/,
        use: {
          loader: "babel-loader",
          options: {
            babelrc: false,
            configFile: false,
            presets: [
              ["@babel/preset-env", { targets: "last 2 chrome version" }],
              "babel-preset-solid",
              "@babel/preset-typescript",
            ],
          },
        },
      },
      {
        test: /\.module\.scss$/,
        use: [
          "style-loader",
          {
            loader: "css-loader",
            options: {
              modules: {
                localIdentName: "[local]__[hash:base64:5]",
              },
              importLoaders: 1,
            },
          },
          {
            loader: "sass-loader",
            options: {
              sassOptions: {
                includePaths: [nodeModulesDir, stylesDir],
              },
            },
          },
        ],
      },
      {
        test: /\.scss$/,
        exclude: settingsDir,
        type: "asset/source",
        use: [
          {
            loader: "sass-loader",
            options: {
              sassOptions: {
                includePaths: [stylesDir],
              },
            },
          },
        ],
      },
    ],
  },

  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
};

module.exports = (env) => {
  const copyWebpackPluginOptions = {
    patterns: [
      {
        from: "src/manifest.json",
        transform: {
          transformer(content) {
            const original = JSON.parse(content.toString());
            // Add the development extension identity and icons.
            const developmentProps = {
              key: "popuptabswitcher", // id: meonejnmljcnoodabklmloagmnmcmlam
              action: {
                default_icon: "images/icon48.png",
              },
              icons: { 48: "images/icon48.png" },
              name: `${original.name} - Development`,
            };
            const updatedManifest = JSON.stringify(
              deepmerge.all([
                original,
                env.development ? developmentProps : {},
              ]),
              null,
              2
            );
            return updatedManifest;
          },
        },
      },
      {
        from: "icon*.png",
        to: "images/",
        context: "src/icons",
      },
      {
        from: "src/settings/index.html",
        to: "settings",
      },
      {
        from: "src/preview/index.html",
        to: "preview",
      },
      {
        from: "src/settings/global-styles/",
        to: "settings/global-styles",
      },
    ],
  };
  if (env.production) {
    conf.mode = "production";
    conf.output.path = buildProdDir;
    conf.plugins = [
      new CopyWebpackPlugin(copyWebpackPluginOptions),
      new webpack.DefinePlugin({
        PRODUCTION: "true",
        DEVELOPMENT: "false",
      }),
    ];
  } else if (env.development) {
    conf.plugins = [
      new CopyWebpackPlugin(copyWebpackPluginOptions),
      new webpack.DefinePlugin({
        PRODUCTION: "false",
        DEVELOPMENT: "true",
      }),
      {
        apply: (compiler) => {
          compiler.hooks.afterEmit.tap("ReloadExtensionPlugin", () => {
            exec('open "https://popuptabswitcher/reload"');
          });
        },
      },
    ];
  }
  return conf;
};

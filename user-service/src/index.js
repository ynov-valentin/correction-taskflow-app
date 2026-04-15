require("./tracing");
const {
  register,
  httpRequestDurationMs,
  httpRequestsTotal,
} = require("./metrics");
const express = require("express");
const pino = require("pino");
const pinoHttp = require("pino-http");

const routes = require("./routes");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();

const ERROR_CODE = 400;

app.use(express.json());
app.use(pinoHttp({ logger }));

app.use(
  pinoHttp({
    logger,
    customLogLevel: (req, res) => {
      if (res.statusCode >= ERROR_CODE) return "error";
      return "info";
    },
    customSuccessMessage: (req, res) => {
      if (res.statusCode >= 400) return req.errorMessage ?? `request failed`;
      return `${req.method} completed`;
    },
    customErrorMessage: (req, res, err) => `request failed : ${err.message}`,
  }),
);

app.use((req, res, next) => {
  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: req.path,
      status: res.statusCode,
    };
    const durationMs = req._startTime
      ? Number(process.hrtime.bigint() - req._startTime) / 1e6
      : 0;
    httpRequestsTotal.inc(labels);
    httpRequestDurationMs.observe(labels, durationMs);
  });
  next();
});

app.get("/health", (req, res) =>
  res.json({ status: "ok", service: "user-service" }),
);

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.use("/users", routes);

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "user-service started");
});
// Record request start time before Express middleware runs
server.prependListener("request", (req) => {
  req._startTime = process.hrtime.bigint();
});

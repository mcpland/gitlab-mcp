import express from "express";
import { gitlabRouter } from "./routes/gitlab";

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get("/health", (req: express.Request, res: express.Response) => {
  res.json({ status: "ok" });
});

// GitLab routes
app.use("/api/gitlab", gitlabRouter);

export default app;

import express, { Router, Request, Response } from "express";
import { handleError } from "../utils/errors";

const router: Router = express.Router();

// Health check endpoint
router.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok", service: "gitlab" });
});

// TODO: Implement GitLab API routes
// Examples:
// router.get('/projects', getProjects);
// router.get('/projects/:id', getProject);
// router.get('/projects/:id/repositories', getRepositories);
// router.get('/projects/:id/merge-requests', getMergeRequests);

export const gitlabRouter = router;

import express from "express";
import { getPublicFaqs } from "../controller/faqController.js";

const router = express.Router();

// No auth — this is help-center content, same as the app's static screens.
router.get("/faqs", getPublicFaqs);

export default router;

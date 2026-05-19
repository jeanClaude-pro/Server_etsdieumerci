const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const authMiddleware = require("../middleware/auth");

// This account is always hidden from other admins and cannot be modified/deleted by them.
const SUPER_ADMIN_EMAIL = "jeanclaudesahani@gmail.com";

router.use(authMiddleware);

function isSuperAdmin(user) {
  return user && user.email === SUPER_ADMIN_EMAIL;
}

// Get current user profile
router.get("/me", async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      "_id username email role isActive permissions actionPermissions"
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Get all users — admin only. Super-admin account is hidden from other admins.
router.get("/", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    let users = await User.find().select(
      "_id username email role isActive permissions actionPermissions createdAt"
    );

    // Hide the super-admin account unless the requester IS the super-admin
    if (!isSuperAdmin(req.user)) {
      users = users.filter((u) => u.email !== SUPER_ADMIN_EMAIL);
    }

    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Create new user — admin only
router.post("/", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    const { username, email, password, role } = req.body;

    const validRoles = [
      "admin",
      "manager",
      "inventory_manager",
      "cashier_supervisor",
      "staff",
    ];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }
    if (!password || password.length < 6) {
      return res
        .status(400)
        .json({ message: "Le mot de passe doit comporter au moins 6 caractères" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, email, password: hashedPassword, role });
    await newUser.save();

    const userResponse = await User.findById(newUser._id).select(
      "_id username email role isActive permissions actionPermissions createdAt"
    );
    res.status(201).json(userResponse);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Cet email est déjà utilisé" });
    }
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update username — admin can update any user, regular users update themselves only
router.put("/:userId/username", async (req, res) => {
  try {
    const { username } = req.body;
    const targetId = req.params.userId;

    if (req.user.role !== "admin" && targetId !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
    if (!username || !username.trim()) {
      return res.status(400).json({ message: "Le nom d'utilisateur ne peut pas être vide" });
    }

    const target = await User.findById(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });

    // Non-super-admins cannot rename the super-admin account
    if (target.email === SUPER_ADMIN_EMAIL && !isSuperAdmin(req.user)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    target.username = username.trim();
    await target.save();

    res.json({
      _id: target._id,
      username: target.username,
      email: target.email,
      role: target.role,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update user role — admin only
router.put("/:userId/role", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    const target = await User.findById(req.params.userId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (target.email === SUPER_ADMIN_EMAIL && !isSuperAdmin(req.user)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    const { role } = req.body;
    const validRoles = [
      "admin",
      "manager",
      "inventory_manager",
      "cashier_supervisor",
      "staff",
    ];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    const updated = await User.findByIdAndUpdate(
      req.params.userId,
      { role },
      { new: true }
    ).select("_id username email role isActive");

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Toggle active status — admin only
router.put("/:userId/status", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.email === SUPER_ADMIN_EMAIL && !isSuperAdmin(req.user)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    user.isActive = !user.isActive;
    await user.save();

    res.json({
      message: `User ${user.isActive ? "activated" : "deactivated"} successfully`,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Delete user — admin only
router.delete("/:userId", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }
    if (req.params.userId === req.user._id.toString()) {
      return res.status(400).json({ message: "Vous ne pouvez pas supprimer votre propre compte" });
    }

    const target = await User.findById(req.params.userId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (target.email === SUPER_ADMIN_EMAIL && !isSuperAdmin(req.user)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    await User.findByIdAndDelete(req.params.userId);
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update page permissions — admin only
router.put("/:userId/permissions", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ message: "Permissions must be an array" });
    }

    const target = await User.findById(req.params.userId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (target.email === SUPER_ADMIN_EMAIL && !isSuperAdmin(req.user)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    const updated = await User.findByIdAndUpdate(
      req.params.userId,
      { permissions },
      { new: true }
    ).select("_id username email role isActive permissions actionPermissions");

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update action permissions — admin only
router.put("/:userId/actions", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Access denied. Admin role required." });
    }

    const { actionPermissions } = req.body;
    if (!Array.isArray(actionPermissions)) {
      return res.status(400).json({ message: "actionPermissions must be an array" });
    }

    const target = await User.findById(req.params.userId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (target.email === SUPER_ADMIN_EMAIL && !isSuperAdmin(req.user)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    const updated = await User.findByIdAndUpdate(
      req.params.userId,
      { actionPermissions },
      { new: true }
    ).select("_id username email role isActive permissions actionPermissions");

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Update profile (username/email) — own account or admin
router.put("/:userId/profile", async (req, res) => {
  try {
    const { username, email } = req.body;
    const targetId = req.params.userId;

    if (req.user.role !== "admin" && targetId !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    const target = await User.findById(targetId);
    if (!target) return res.status(404).json({ message: "User not found" });
    if (target.email === SUPER_ADMIN_EMAIL && !isSuperAdmin(req.user)) {
      return res.status(403).json({ message: "Action non autorisée sur ce compte" });
    }

    const updateData = {};
    if (username) updateData.username = username.trim();
    if (email) updateData.email = email.trim().toLowerCase();

    const updated = await User.findByIdAndUpdate(targetId, updateData, {
      new: true,
    }).select("_id username email role isActive");

    res.json(updated);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Email already exists" });
    }
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;

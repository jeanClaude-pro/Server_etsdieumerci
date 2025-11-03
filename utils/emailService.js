const nodemailer = require("nodemailer");
const User = require("../models/User");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ✅ CONFIGURATION DE L'ENTREPRISE
const COMPANY_NAME = "EST. DIEU MERCI";
const COMPANY_SLOGAN = "Votre Partenaire de Confiance";
const COMPANY_COLOR = "#1e40af";
const COMPANY_SECONDARY_COLOR = "#dc2626";

// Fonction DEBUG pour voir tous les utilisateurs
async function debugAllUsers() {
  try {
    console.log("🐛 DEBUG: Recherche de TOUS les utilisateurs...");
    const allUsers = await User.find({}).select("email username role isActive createdAt");
    console.log(`🐛 DEBUG: Total utilisateurs dans la base: ${allUsers.length}`);
    
    allUsers.forEach((user, index) => {
      console.log(`🐛 DEBUG [${index + 1}]: ${user.email} | ${user.username} | role: "${user.role}" | actif: ${user.isActive} | créé: ${user.createdAt}`);
    });
    
    return allUsers;
  } catch (error) {
    console.error("🐛 DEBUG Erreur:", error);
    return [];
  }
}

// Fonction pour obtenir tous les emails des administrateurs - VERSION CORRIGÉE
async function getAdminEmails() {
  try {
    console.log("🔍 Recherche des administrateurs...");

    // D'abord, debug complet
    await debugAllUsers();

    // Essayer différentes méthodes de recherche
    console.log("🔍 Méthode 1: Recherche exacte 'admin'");
    const method1 = await User.find({ 
      role: "admin",
      isActive: true 
    }).select("email username role isActive");
    console.log(`🔍 Méthode 1 trouvée: ${method1.length} admin(s)`);

    console.log("🔍 Méthode 2: Recherche insensible à la casse");
    const method2 = await User.find({
      $or: [
        { role: "admin" },
        { role: "Admin" },
        { role: "ADMIN" }
      ],
      isActive: true
    }).select("email username role isActive");
    console.log(`🔍 Méthode 2 trouvée: ${method2.length} admin(s)`);

    console.log("🔍 Méthode 3: Tous les rôles admin (même inactifs)");
    const method3 = await User.find({
      $or: [
        { role: "admin" },
        { role: "Admin" },
        { role: "ADMIN" }
      ]
    }).select("email username role isActive");
    console.log(`🔍 Méthode 3 trouvée: ${method3.length} admin(s)`);

    // Utiliser la méthode qui trouve le plus d'admins
    let adminUsers = method2; // Méthode insensible à la casse par défaut
    
    if (method1.length > adminUsers.length) adminUsers = method1;
    if (method3.length > adminUsers.length) {
      console.log("🚨 Utilisation des admins même inactifs comme fallback");
      adminUsers = method3;
    }

    console.log(`📧 ${adminUsers.length} administrateur(s) trouvé(s) pour notification:`);
    adminUsers.forEach(admin => {
      console.log(`   ✅ ${admin.email} (${admin.username}) - rôle: "${admin.role}" - actif: ${admin.isActive}`);
    });
    
    const adminEmails = adminUsers.map((user) => user.email);
    return adminEmails;
  } catch (error) {
    console.error("❌ Erreur lors de la recherche des administrateurs:", error);
    return [];
  }
}

// Fonction pour envoyer la notification de dépense à tous les administrateurs
async function sendExpenseNotification(expense) {
  try {
    console.log("🔄 Lancement de la notification par email...");
    
    // Obtenir tous les emails des administrateurs actifs
    const adminEmails = await getAdminEmails();

    if (adminEmails.length === 0) {
      console.log("🚨 URGENCE: Aucun administrateur trouvé - tentative d'envoi à un email par défaut");
      
      // Fallback d'urgence - envoyer à un email spécifique
      const emergencyEmail = "votre-email@entreprise.com"; // ⚠️ REMPLACEZ PAR VOTRE EMAIL
      console.log(`🆘 Envoi d'urgence à: ${emergencyEmail}`);
      
      await sendEmailToRecipients(expense, [emergencyEmail]);
      return;
    }

    console.log(`✅ Notification envoyée à ${adminEmails.length} administrateur(s)`);
    await sendEmailToRecipients(expense, adminEmails);
    
  } catch (error) {
    console.error("❌ Échec de l'envoi de la notification de dépense:", error);
  }
}

// Fonction séparée pour envoyer l'email
async function sendEmailToRecipients(expense, recipientEmails) {
  try {
    // Formater le montant en devise
    const formattedAmount = new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "USD",
    }).format(expense.amount);

    // Traduire le statut
    const statusTranslations = {
      "pending": "En attente",
      "validated": "Validée", 
      "rejected": "Rejetée"
    };
    
    const translatedStatus = statusTranslations[expense.status] || expense.status;

    // Traduire la méthode de paiement
    const paymentMethodTranslations = {
      "cash": "Espèces",
      "card": "Carte",
      "bank": "Transfert bancaire",
      "mpesa": "M-Pesa",
      "other": "Autre"
    };
    
    const translatedPaymentMethod = paymentMethodTranslations[expense.paymentMethod] || expense.paymentMethod;

    // Créer le contenu de l'email
    const mailOptions = {
      from: `${COMPANY_NAME} <${process.env.GMAIL_USER}>`,
      to: recipientEmails.join(", "),
      subject: `💸 ${COMPANY_NAME} - Nouvelle Dépense Enregistrée - ${expense.reason}`,
      html: `
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Nouvelle Dépense - ${COMPANY_NAME}</title>
        </head>
        <body style="font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background-color: #f8fafc;">
            <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <!-- En-tête de l'entreprise -->
                <div style="background: linear-gradient(135deg, ${COMPANY_COLOR}, ${COMPANY_SECONDARY_COLOR}); padding: 30px 20px; text-align: center; color: white;">
                    <h1 style="margin: 0; font-size: 28px; font-weight: 700;">${COMPANY_NAME}</h1>
                    <p style="margin: 5px 0 0 0; font-size: 16px; opacity: 0.9;">${COMPANY_SLOGAN}</p>
                </div>

                <!-- Bannière de notification -->
                <div style="background: #fef3f2; border-left: 4px solid ${COMPANY_SECONDARY_COLOR}; padding: 20px; margin: 20px;">
                    <div style="display: flex; align-items: center;">
                        <div style="background: ${COMPANY_SECONDARY_COLOR}; color: white; border-radius: 50%; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; margin-right: 15px; font-size: 18px;">
                            💸
                        </div>
                        <div>
                            <h2 style="margin: 0; color: ${COMPANY_SECONDARY_COLOR}; font-size: 20px;">Nouvelle Dépense Enregistrée</h2>
                            <p style="margin: 5px 0 0 0; color: #6b7280; font-size: 14px;">Une nouvelle sortie de caisse a été effectuée dans le système</p>
                        </div>
                    </div>
                </div>

                <!-- Carte des détails de la dépense -->
                <div style="padding: 0 25px 25px 25px;">
                    <div style="background: #f8fafc; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                        <h3 style="color: ${COMPANY_COLOR}; margin-top: 0; border-bottom: 2px solid ${COMPANY_COLOR}; padding-bottom: 10px; font-size: 18px;">
                            📋 Détails de la Transaction
                        </h3>
                        
                        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                            <tr>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; width: 40%;"><strong>🔖 Référence:</strong></td>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">${expense.expenseId}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280;"><strong>📝 Motif:</strong></td>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">${expense.reason}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280;"><strong>👤 Bénéficiaire:</strong></td>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">${expense.recipientName}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280;"><strong>📞 Téléphone:</strong></td>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">${expense.recipientPhone}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280;"><strong>💰 Montant:</strong></td>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600; color: ${COMPANY_SECONDARY_COLOR}; font-size: 16px;">${formattedAmount}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280;"><strong>💳 Mode de paiement:</strong></td>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">${translatedPaymentMethod}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280;"><strong>👨‍💼 Enregistré par:</strong></td>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">${expense.recordedBy}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280;"><strong>📊 Statut:</strong></td>
                                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb;">
                                    <span style="background: #fef3c7; color: #d97706; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600;">${translatedStatus}</span>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; color: #6b7280;"><strong>📅 Date et heure:</strong></td>
                                <td style="padding: 10px 0; font-weight: 600;">${new Date(expense.createdAt).toLocaleDateString("fr-FR", { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} à ${new Date(expense.createdAt).toLocaleTimeString("fr-FR", { hour: '2-digit', minute: '2-digit' })}</td>
                            </tr>
                        </table>
                    </div>

                    <!-- Section des notes -->
                    ${expense.notes ? `
                    <div style="background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                        <h4 style="color: ${COMPANY_COLOR}; margin: 0 0 8px 0; font-size: 16px; display: flex; align-items: center;">
                            <span style="margin-right: 8px;">📝</span>
                            Notes Complémentaires
                        </h4>
                        <p style="margin: 0; color: #1e40af; font-style: italic; line-height: 1.5;">${expense.notes}</p>
                    </div>
                    ` : ''}

                    <!-- Bouton d'action -->
                    <div style="text-align: center; margin: 25px 0;">
                        <a href="${process.env.POS_URL || "https://etsdieumerci.netlify.app/login"}/expenses" 
                           style="background: linear-gradient(135deg, ${COMPANY_COLOR}, ${COMPANY_SECONDARY_COLOR}); color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; display: inline-block; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); transition: all 0.3s;">
                            🔍 Voir le Détail dans le Système
                        </a>
                    </div>

                    <!-- Informations de sécurité -->
                    <div style="background: #fef7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 15px; margin-top: 20px;">
                        <p style="margin: 0; color: #ea580c; font-size: 12px; text-align: center;">
                            🔒 Cette notification a été générée automatiquement. 
                            Si vous pensez avoir reçu cet email par erreur, veuillez contacter l'administrateur du système.
                        </p>
                    </div>
                </div>

                <!-- Pied de page -->
                <div style="background: #1f2937; color: #9ca3af; padding: 20px; text-align: center; font-size: 12px;">
                    <p style="margin: 0 0 10px 0;">
                        <strong style="color: white;">${COMPANY_NAME}</strong><br>
                        Système de Gestion des Dépenses
                    </p>
                    <p style="margin: 0; line-height: 1.5;">
                        Cet email a été envoyé automatiquement à tous les administrateurs du système.<br>
                        © ${new Date().getFullYear()} ${COMPANY_NAME}. Tous droits réservés.
                    </p>
                </div>
            </div>
        </body>
        </html>
      `,
    };

    // Envoyer l'email
    await transporter.sendMail(mailOptions);
    console.log(`✅ ${COMPANY_NAME} - Notification de dépense envoyée à ${recipientEmails.length} administrateur(s): ${recipientEmails.join(', ')}`);
  } catch (error) {
    console.error("❌ Échec de l'envoi de l'email:", error);
    throw error;
  }
}

module.exports = {
  sendExpenseNotification,
  getAdminEmails,
};
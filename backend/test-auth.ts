/**
 * Simple test script for authentication module
 * Run with: npx tsx test-auth.ts
 */

import { AuthService } from './src/auth-service.js';

async function testAuth() {
    console.log('🧪 Testing Authentication Module\n');

    const authService = new AuthService();

    try {
        // Test 1: Register a new user
        console.log('1️⃣  Testing User Registration...');
        const registerResult = await authService.register({
            email: 'test@example.com',
            password: 'password123',
            name: 'Test User'
        });
        console.log('✅ User registered successfully');
        console.log('   User ID:', registerResult.user.id);
        console.log('   Email:', registerResult.user.email);
        console.log('   Name:', registerResult.user.name);
        console.log('   Access Token (first 50 chars):', registerResult.tokens.accessToken.substring(0, 50) + '...');
        console.log('   Refresh Token (first 50 chars):', registerResult.tokens.refreshToken.substring(0, 50) + '...\n');

        // Test 2: Try to register same user again (should fail)
        console.log('2️⃣  Testing Duplicate Registration (should fail)...');
        try {
            await authService.register({
                email: 'test@example.com',
                password: 'password456',
                name: 'Test User 2'
            });
            console.log('❌ Test failed: Should have thrown an error');
        } catch (error) {
            console.log('✅ Correctly rejected duplicate registration');
            console.log('   Error:', (error as Error).message + '\n');
        }

        // Test 3: Login with correct credentials
        console.log('3️⃣  Testing Login with Correct Credentials...');
        const loginResult = await authService.login({
            email: 'test@example.com',
            password: 'password123'
        });
        console.log('✅ Login successful');
        console.log('   User ID:', loginResult.user.id);
        console.log('   New Access Token (first 50 chars):', loginResult.tokens.accessToken.substring(0, 50) + '...\n');

        // Test 4: Login with wrong password (should fail)
        console.log('4️⃣  Testing Login with Wrong Password (should fail)...');
        try {
            await authService.login({
                email: 'test@example.com',
                password: 'wrongpassword'
            });
            console.log('❌ Test failed: Should have thrown an error');
        } catch (error) {
            console.log('✅ Correctly rejected wrong password');
            console.log('   Error:', (error as Error).message + '\n');
        }

        // Test 5: Verify access token
        console.log('5️⃣  Testing Access Token Verification...');
        const tokenPayload = authService.verifyAccessToken(loginResult.tokens.accessToken);
        console.log('✅ Token verified successfully');
        console.log('   User ID from token:', tokenPayload.userId);
        console.log('   Email from token:', tokenPayload.email);
        console.log('   Token type:', tokenPayload.type + '\n');

        // Test 6: Refresh access token
        console.log('6️⃣  Testing Token Refresh...');
        const newTokens = await authService.refreshAccessToken(loginResult.tokens.refreshToken);
        console.log('✅ Token refreshed successfully');
        console.log('   New Access Token (first 50 chars):', newTokens.accessToken.substring(0, 50) + '...');
        console.log('   New Refresh Token (first 50 chars):', newTokens.refreshToken.substring(0, 50) + '...\n');

        // Test 7: Get user by ID
        console.log('7️⃣  Testing Get User by ID...');
        const user = authService.getUserById(registerResult.user.id);
        if (user) {
            console.log('✅ User retrieved successfully');
            console.log('   Email:', user.email);
            console.log('   Name:', user.name + '\n');
        } else {
            console.log('❌ User not found\n');
        }

        // Test 8: Logout
        console.log('8️⃣  Testing Logout...');
        authService.logout(newTokens.refreshToken);
        console.log('✅ User logged out (refresh token invalidated)');

        // Try to use invalidated refresh token
        try {
            await authService.refreshAccessToken(newTokens.refreshToken);
            console.log('❌ Test failed: Should have thrown an error');
        } catch (error) {
            console.log('✅ Correctly rejected invalidated refresh token');
            console.log('   Error:', (error as Error).message + '\n');
        }

        // Test 9: Register another user
        console.log('9️⃣  Testing Second User Registration...');
        const secondUser = await authService.register({
            email: 'user2@example.com',
            password: 'password456',
            name: 'User Two'
        });
        console.log('✅ Second user registered successfully');
        console.log('   User ID:', secondUser.user.id);
        console.log('   Email:', secondUser.user.email + '\n');

        // Test 10: Get all users
        console.log('🔟 Testing Get All Users...');
        const allUsers = authService.getAllUsers();
        console.log('✅ Retrieved all users');
        console.log('   Total users:', allUsers.length);
        allUsers.forEach((u, index) => {
            console.log(`   ${index + 1}. ${u.email} (${u.name || 'No name'})`);
        });

        console.log('\n🎉 All tests passed successfully!');

    } catch (error) {
        console.error('❌ Test failed with error:', error);
    }
}

// Run tests
testAuth();

# Oxy Code Examples

Complete working examples for common use cases.

## Table of Contents

- [Authentication Examples](#authentication-examples)
- [User Management Examples](#user-management-examples)
- [File Upload Examples](#file-upload-examples)
- [Social Features Examples](#social-features-examples)
- [Real-World Apps](#real-world-apps)

## Authentication Examples

### Complete Login Flow

```typescript
import { useOxy } from '@oxy.so/services';
import { useState } from 'react';
import { View, TextInput, Button, Alert } from 'react-native';

function LoginScreen() {
  const { login, isAuthenticated, user } = useOxy();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) {
      Alert.alert('Error', 'Please enter username and password');
      return;
    }

    setLoading(true);
    try {
      await login(username, password);
      Alert.alert('Success', `Welcome, ${user?.name}!`);
    } catch (error: any) {
      Alert.alert('Login Failed', error.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  if (isAuthenticated) {
    return <Text>Already logged in as {user?.name}</Text>;
  }

  return (
    <View style={{ padding: 20 }}>
      <TextInput
        value={username}
        onChangeText={setUsername}
        placeholder="Username"
        autoCapitalize="none"
        style={{ borderWidth: 1, padding: 10, marginBottom: 10 }}
      />
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        secureTextEntry
        style={{ borderWidth: 1, padding: 10, marginBottom: 10 }}
      />
      <Button
        title={loading ? "Signing in..." : "Sign In"}
        onPress={handleLogin}
        disabled={loading}
      />
    </View>
  );
}
```

### Sign Up Flow

```typescript
import { useOxy } from '@oxy.so/services';
import { useState } from 'react';

function SignUpScreen() {
  const { oxyServices } = useOxy();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignUp = async () => {
    setLoading(true);
    try {
      const response = await oxyServices.signUp(username, email, password);
      // User is automatically logged in after signup
      console.log('Account created:', response.user);
    } catch (error: any) {
      Alert.alert('Sign Up Failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View>
      <TextInput value={username} onChangeText={setUsername} placeholder="Username" />
      <TextInput value={email} onChangeText={setEmail} placeholder="Email" keyboardType="email-address" />
      <TextInput value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
      <Button title="Sign Up" onPress={handleSignUp} disabled={loading} />
    </View>
  );
}
```

## User Management Examples

### User Profile Screen

```typescript
import { useOxy } from '@oxy.so/services';
import { useEffect, useState } from 'react';
import { View, Text, Image, ActivityIndicator } from 'react-native';

function UserProfile({ userId }: { userId: string }) {
  const { oxyServices } = useOxy();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [followers, setFollowers] = useState([]);
  const [following, setFollowing] = useState([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [userData, followersData, followingData] = await Promise.all([
          oxyServices.getUserById(userId),
          oxyServices.getUserFollowers(userId),
          oxyServices.getUserFollowing(userId)
        ]);
        
        setUser(userData);
        setFollowers(followersData.followers);
        setFollowing(followingData.following);
      } catch (error) {
        console.error('Failed to fetch user data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [userId]);

  if (loading) {
    return <ActivityIndicator />;
  }

  if (!user) {
    return <Text>User not found</Text>;
  }

  return (
    <View>
      {user.avatar && (
        <Image
          source={{ uri: oxyServices.getFileDownloadUrl(user.avatar, 'thumb') }}
          style={{ width: 100, height: 100, borderRadius: 50 }}
        />
      )}
      <Text style={{ fontSize: 24, fontWeight: 'bold' }}>{user.name}</Text>
      <Text>@{user.username}</Text>
      {user.bio && <Text>{user.bio}</Text>}
      <View style={{ flexDirection: 'row', marginTop: 20 }}>
        <Text>Followers: {followers.length}</Text>
        <Text style={{ marginLeft: 20 }}>Following: {following.length}</Text>
      </View>
    </View>
  );
}
```

### Edit Profile

```typescript
import { useOxy } from '@oxy.so/services';
import { useState } from 'react';

function EditProfileScreen() {
  const { oxyServices, user } = useOxy();
  const [name, setName] = useState(user?.name || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await oxyServices.updateProfile({ name, bio });
      Alert.alert('Success', 'Profile updated');
    } catch (error: any) {
      Alert.alert('Error', error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <TextInput value={name} onChangeText={setName} placeholder="Name" />
      <TextInput value={bio} onChangeText={setBio} placeholder="Bio" multiline />
      <Button title={saving ? "Saving..." : "Save"} onPress={handleSave} disabled={saving} />
    </View>
  );
}
```

## File Upload Examples

### Image Upload with Preview

```typescript
import { useOxy } from '@oxy.so/services';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';

function ImageUpload() {
  const { oxyServices } = useOxy();
  const [image, setImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadedFileId, setUploadedFileId] = useState<string | null>(null);

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please grant camera roll permissions');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 1,
    });

    if (!result.canceled) {
      setImage(result.assets[0].uri);
      await uploadImage(result.assets[0].uri);
    }
  };

  const uploadImage = async (uri: string) => {
    setUploading(true);
    try {
      const response = await fetch(uri);
      const blob = await response.blob();
      const file = new File([blob], 'image.jpg', { type: 'image/jpeg' });
      
      const uploaded = await oxyServices.uploadRawFile(file, 'public');
      setUploadedFileId(uploaded.file.id);
      Alert.alert('Success', 'Image uploaded!');
    } catch (error: any) {
      Alert.alert('Upload Failed', error.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <View>
      {image && (
        <Image source={{ uri: image }} style={{ width: 200, height: 200 }} />
      )}
      {uploadedFileId && (
        <Image
          source={{ uri: oxyServices.getFileDownloadUrl(uploadedFileId, 'thumb') }}
          style={{ width: 200, height: 200 }}
        />
      )}
      <Button
        title={uploading ? "Uploading..." : "Pick and Upload Image"}
        onPress={pickImage}
        disabled={uploading}
      />
    </View>
  );
}
```

### Multiple File Upload

```typescript
import { useOxy } from '@oxy.so/services';
import { useState } from 'react';

function MultipleFileUpload() {
  const { oxyServices } = useOxy();
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    setFiles(selectedFiles);
  };

  const uploadFiles = async () => {
    setUploading(true);
    try {
      const uploadPromises = files.map(file =>
        oxyServices.uploadRawFile(file, 'public')
      );
      const results = await Promise.all(uploadPromises);
      setUploadedFiles(results);
      Alert.alert('Success', `${results.length} files uploaded`);
    } catch (error: any) {
      Alert.alert('Upload Failed', error.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <input type="file" multiple onChange={handleFileSelect} />
      <button onClick={uploadFiles} disabled={uploading || files.length === 0}>
        {uploading ? 'Uploading...' : `Upload ${files.length} files`}
      </button>
      {uploadedFiles.map((file, index) => (
        <div key={index}>
          <img src={oxyServices.getFileDownloadUrl(file.file.id, 'thumb')} alt="Uploaded" />
        </div>
      ))}
    </div>
  );
}
```

## Social Features Examples

### Follow/Unfollow Button

```typescript
import { useOxy } from '@oxy.so/services';
import { useState, useEffect } from 'react';

function FollowButton({ userId }: { userId: string }) {
  const { oxyServices } = useOxy();
  const [isFollowing, setIsFollowing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const checkFollowStatus = async () => {
      try {
        const status = await oxyServices.getFollowStatus(userId);
        setIsFollowing(status.isFollowing);
      } catch (error) {
        console.error('Failed to check follow status:', error);
      }
    };
    checkFollowStatus();
  }, [userId]);

  const handleToggleFollow = async () => {
    setLoading(true);
    try {
      if (isFollowing) {
        await oxyServices.unfollowUser(userId);
        setIsFollowing(false);
      } else {
        await oxyServices.followUser(userId);
        setIsFollowing(true);
      }
    } catch (error: any) {
      Alert.alert('Error', error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      title={isFollowing ? 'Unfollow' : 'Follow'}
      onPress={handleToggleFollow}
      disabled={loading}
    />
  );
}
```

### Followers List

```typescript
import { useOxy } from '@oxy.so/services';
import { useState, useEffect } from 'react';
import { FlatList, View, Text, Image } from 'react-native';

function FollowersList({ userId }: { userId: string }) {
  const { oxyServices } = useOxy();
  const [followers, setFollowers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);

  const loadFollowers = async () => {
    try {
      const result = await oxyServices.getUserFollowers(userId, {
        limit: 20,
        offset
      });
      setFollowers(prev => [...prev, ...result.followers]);
      setHasMore(result.hasMore);
      setOffset(prev => prev + 20);
    } catch (error) {
      console.error('Failed to load followers:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFollowers();
  }, []);

  const renderFollower = ({ item }: { item: User }) => (
    <View style={{ flexDirection: 'row', padding: 10, alignItems: 'center' }}>
      {item.avatar && (
        <Image
          source={{ uri: oxyServices.getFileDownloadUrl(item.avatar, 'thumb') }}
          style={{ width: 50, height: 50, borderRadius: 25, marginRight: 10 }}
        />
      )}
      <View>
        <Text style={{ fontWeight: 'bold' }}>{item.name}</Text>
        <Text>@{item.username}</Text>
      </View>
    </View>
  );

  return (
    <FlatList
      data={followers}
      renderItem={renderFollower}
      keyExtractor={item => item.id}
      onEndReached={() => hasMore && !loading && loadFollowers()}
      onEndReachedThreshold={0.5}
    />
  );
}
```

## Real-World Apps

### Social Media App

```typescript
// App.tsx
import { OxyProvider } from '@oxy.so/services';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';

const Stack = createStackNavigator();

export default function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so">
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Home" component={HomeScreen} />
          <Stack.Screen name="Profile" component={ProfileScreen} />
          <Stack.Screen name="Login" component={LoginScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </OxyProvider>
  );
}

// HomeScreen.tsx
import { useOxy } from '@oxy.so/services';
import { useEffect, useState } from 'react';

function HomeScreen({ navigation }) {
  const { user, isAuthenticated, oxyServices } = useOxy();
  const [posts, setPosts] = useState([]);

  useEffect(() => {
    if (isAuthenticated) {
      // Fetch user's feed
      // This would be a custom endpoint in your API
    }
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return (
      <View>
        <Text>Please sign in</Text>
        <Button title="Sign In" onPress={() => navigation.navigate('Login')} />
      </View>
    );
  }

  return (
    <ScrollView>
      <Text>Welcome, {user?.name}!</Text>
      {/* Render posts */}
    </ScrollView>
  );
}
```

### E-Commerce App

```typescript
// ProductScreen.tsx
import { useOxy } from '@oxy.so/services';
import { useState } from 'react';

function ProductScreen({ productId }: { productId: string }) {
  const { oxyServices, isAuthenticated } = useOxy();
  const [product, setProduct] = useState(null);
  const [purchasing, setPurchasing] = useState(false);

  const handlePurchase = async () => {
    if (!isAuthenticated) {
      Alert.alert('Sign In Required', 'Please sign in to purchase');
      return;
    }

    setPurchasing(true);
    try {
      const payment = await oxyServices.createPayment({
        amount: product.price,
        currency: 'USD',
        description: product.name,
        productId: product.id
      });
      // Handle payment success
      Alert.alert('Success', 'Purchase completed!');
    } catch (error: any) {
      Alert.alert('Purchase Failed', error.message);
    } finally {
      setPurchasing(false);
    }
  };

  return (
    <View>
      {product && (
        <>
          <Image source={{ uri: oxyServices.getFileDownloadUrl(product.image) }} />
          <Text>{product.name}</Text>
          <Text>${product.price}</Text>
          <Button
            title={purchasing ? "Processing..." : "Buy Now"}
            onPress={handlePurchase}
            disabled={purchasing}
          />
        </>
      )}
    </View>
  );
}
```

### Content Management App

```typescript
// ContentEditor.tsx
import { useOxy } from '@oxy.so/services';
import { useState } from 'react';

function ContentEditor() {
  const { oxyServices } = useOxy();
  const [content, setContent] = useState('');
  const [uploadedImages, setUploadedImages] = useState<string[]>([]);

  const handleImageUpload = async (file: File) => {
    try {
      const uploaded = await oxyServices.uploadRawFile(file, 'public');
      const imageUrl = oxyServices.getFileDownloadUrl(uploaded.file.id);
      setUploadedImages(prev => [...prev, imageUrl]);
      // Insert image into content
      setContent(prev => prev + `\n![Image](${imageUrl})\n`);
    } catch (error) {
      console.error('Image upload failed:', error);
    }
  };

  return (
    <View>
      <TextInput
        value={content}
        onChangeText={setContent}
        multiline
        placeholder="Write your content..."
      />
      <input
        type="file"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImageUpload(file);
        }}
      />
    </View>
  );
}
```

## Next Steps

- [API Reference](./API_REFERENCE.md) - Complete method documentation
- [Best Practices](./BEST_PRACTICES.md) - Production-ready patterns
- [Integration Guide](./INTEGRATION_GUIDE.md) - Platform-specific guides

